import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadConfig } from "../config.ts";
import { sendError } from "../errors.ts";
import { isTokenExpired, loadByAccessToken, updateSession } from "../store.ts";

const ALLOWED_SVC_TYPES = new Set(["M", "F", "I", "U"]);
const ALLOWED_METHOD_TYPES = new Set(["GET", "POST"]);

interface AuthUrlBody {
  request_no: unknown;
  return_url: unknown;
  close_url: unknown;
  svc_types: unknown;
  method_type: unknown;
  exp_mods: unknown;
}

function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length).trim();
  return token === "" ? undefined : token;
}

function isValidRequestNo(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 50;
}

function isValidHttpUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("http");
}

function isValidSvcTypes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (entry): entry is string => typeof entry === "string" && ALLOWED_SVC_TYPES.has(entry),
  );
}

export default async function routes(app: FastifyInstance): Promise<void> {
  app.post("/ido/intc/v1.0/auth/url", async (request, reply) => {
    const token = extractBearer(request);
    if (token === undefined) {
      request.log.warn(
        { route: "auth/url", result_code: "1004", reason: "missing_bearer" },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1004");
    }
    const session = loadByAccessToken(token);
    if (session === undefined) {
      request.log.warn(
        { route: "auth/url", result_code: "1004", reason: "unknown_token", access_token: token },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1004");
    }
    if (isTokenExpired(session)) {
      request.log.warn(
        {
          route: "auth/url",
          result_code: "1003",
          reason: "token_expired",
          client_id: session.clientId,
          request_no: session.requestNo,
          access_token: token,
        },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1003");
    }
    const sessionRef = {
      route: "auth/url" as const,
      client_id: session.clientId,
      request_no: session.requestNo,
      access_token: token,
    };

    const body = request.body as AuthUrlBody | undefined;
    if (body === undefined || body === null || typeof body !== "object") {
      request.log.warn(
        { ...sessionRef, result_code: "1002", reason: "non_json_body" },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1002");
    }
    if (!isValidRequestNo(body.request_no)) {
      request.log.warn(
        {
          ...sessionRef,
          result_code: "1002",
          reason: "invalid_request_no",
          request_no: body.request_no,
        },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1002");
    }
    // request_no 는 본인인증 흐름 전체를 잇는 키다. token 발급 때 만든 값을
    // 그대로 써야 한다 (가이드 /auth/url 설명의 "token 값과 무관" 문구는 실
    // 서비스 동작과 다르다).
    const requestNo = body.request_no;
    if (session.requestNo !== requestNo) {
      request.log.warn(
        {
          ...sessionRef,
          result_code: "1004",
          reason: "request_no_mismatch",
          presented_request_no: requestNo,
        },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1004");
    }
    if (!isValidHttpUrl(body.return_url)) {
      request.log.warn(
        { ...sessionRef, result_code: "1002", reason: "invalid_return_url" },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1002");
    }
    const returnUrl = body.return_url;
    if (!isValidSvcTypes(body.svc_types)) {
      request.log.warn(
        { ...sessionRef, result_code: "1002", reason: "invalid_svc_types" },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1002");
    }
    const svcTypes = body.svc_types;

    let methodType = "GET";
    if (body.method_type !== undefined) {
      if (typeof body.method_type !== "string" || !ALLOWED_METHOD_TYPES.has(body.method_type)) {
        request.log.warn(
          { ...sessionRef, result_code: "1002", reason: "invalid_method_type" },
          "인증 URL 발급 거부",
        );
        return sendError(reply, "1002");
      }
      methodType = body.method_type;
    }

    let closeUrl: string | undefined;
    if (body.close_url !== undefined && body.close_url !== null && body.close_url !== "") {
      if (!isValidHttpUrl(body.close_url)) {
        request.log.warn(
          { ...sessionRef, result_code: "1002", reason: "invalid_close_url" },
          "인증 URL 발급 거부",
        );
        return sendError(reply, "1002");
      }
      closeUrl = body.close_url;
    }

    let expMods: string[] = [];
    if (body.exp_mods !== undefined) {
      if (
        !Array.isArray(body.exp_mods) ||
        !body.exp_mods.every((entry): entry is string => typeof entry === "string")
      ) {
        request.log.warn(
          { ...sessionRef, result_code: "1002", reason: "invalid_exp_mods" },
          "인증 URL 발급 거부",
        );
        return sendError(reply, "1002");
      }
      expMods = [...body.exp_mods];
    }

    const config = loadConfig();
    const base = config.publicBaseUrl.replace(/\/+$/, "");
    const certId = `S${randomUUID()}`;
    const transactionId = randomBytes(42).toString("base64url");
    const authUrl = `${base}/ido/cert/request/${certId}`;

    const updated = updateSession(session.requestNo, {
      certId,
      transactionId,
      returnUrl,
      closeUrl,
      svcTypes: [...svcTypes],
      methodType,
      expMods,
      authUrlExpiresAt: Date.now() + config.authUrlTtlMs,
      status: "PENDING",
    });
    if (updated === undefined) {
      request.log.warn(
        { ...sessionRef, result_code: "1004", reason: "session_vanished" },
        "인증 URL 발급 거부",
      );
      return sendError(reply, "1004");
    }
    request.log.info(
      {
        route: "auth/url",
        result_code: "0000",
        client_id: session.clientId,
        request_no: requestNo,
        cert_id: certId,
        transaction_id: transactionId,
        svc_types: svcTypes,
        method_type: methodType,
        return_url: returnUrl,
      },
      "인증 URL 발급 성공",
    );

    return reply.code(200).send({
      result_code: "0000",
      result_message: "응답성공",
      request_no: requestNo,
      auth_url: authUrl,
      transaction_id: transactionId,
    });
  });
}
