import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { validateClientCredentials } from "../clients.ts";
import { loadConfig } from "../config.ts";
import { errorBody, sendError } from "../errors.ts";
import { createSession } from "../store.ts";

const ROUTE_PATH = "/ido/intc/v1.0/auth/token";

// Sentinel produced by the scoped JSON parser when the payload is not
// parseable JSON. The handler maps it to 3001 (HTTP 200) instead of
// Fastify's default 400 so the mock matches the ResultCode table
// (3xxx -> 200).
const JSON_PARSE_FAILED: unique symbol = Symbol("nice-mock-json-parse-failed");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodeOf(error: unknown): string | undefined {
  const code: unknown = (error as unknown as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorStatusOf(error: unknown): number | undefined {
  const status: unknown = (error as unknown as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

export default async function routes(app: FastifyInstance): Promise<void> {
  // Scoped override of the default JSON parser: unparseable payloads must
  // surface as 3001 from the handler, not as Fastify's default 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    void req;
    const text = body as string;
    if (text === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(null, JSON_PARSE_FAILED);
    }
  });

  // Anything the parsers reject outright (e.g. text/plain garbage with no
  // registered parser -> 415) is a non-JSON body -> 3001 (HTTP 200).
  app.setErrorHandler((error, _request, reply) => {
    const code = errorCodeOf(error);
    if (
      errorStatusOf(error) === 415 ||
      code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
      code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      reply.code(200).send(errorBody("3001"));
      return;
    }
    reply.send(error);
  });

  app.post(ROUTE_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const config = loadConfig();

    // 1. Authorization: Basic <base64url_nopad(clientId:clientSecret)>.
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Basic ")) {
      return sendError(reply, "1001");
    }
    const token = header.slice("Basic ".length).trim();
    if (token === "") {
      return sendError(reply, "1001");
    }
    let clientId: string;
    let clientSecret: string;
    try {
      // 가이드 표준은 base64url 무패딩이지만, 가이드 Node.js 샘플처럼 표준
      // base64(+/)로 보내는 클라이언트도 같은 값으로 받아준다.
      const normalized = token.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const raw = Buffer.from(normalized, "base64url");
      if (raw.length === 0 || raw.toString("base64url") !== normalized) {
        return sendError(reply, "1001");
      }
      const decoded = raw.toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator <= 0) {
        return sendError(reply, "1001");
      }
      clientId = decoded.slice(0, separator);
      clientSecret = decoded.slice(separator + 1);
    } catch {
      return sendError(reply, "1001");
    }
    // strict=false skips the DB lookup entirely (local-debug bypass).
    if (config.strictCredentials && !validateClientCredentials(clientId, clientSecret)) {
      return sendError(reply, "1006");
    }

    // 2. Body: JSON object (or the form-urlencoded fallback registered in
    // app.ts). Anything else -> 3001 (HTTP 200).
    const body: unknown = request.body;
    if (!isRecord(body) || body === (JSON_PARSE_FAILED as unknown as Record<string, unknown>)) {
      return reply.code(200).send(errorBody("3001"));
    }
    if (body["grant_type"] !== "client_credentials") {
      return sendError(reply, "1002");
    }
    const requestNo: unknown = body["request_no"];
    if (typeof requestNo !== "string" || requestNo.length < 20 || requestNo.length > 50) {
      return sendError(reply, "1002");
    }

    // 3. Create/replace the session. A repeat call rotates ticket /
    // iterators / accessToken and invalidates the previous token
    // (handled inside createSession).
    const session = createSession(requestNo, {
      tokenTtlMs: config.tokenTtlMs,
      iterators: config.iterators,
      clientId,
    });

    return reply.code(200).send({
      result_code: "0000",
      result_message: "응답성공",
      request_no: session.requestNo,
      access_token: session.accessToken,
      expires_in: session.tokenExpiresAt,
      token_type: "Bearer",
      iterators: session.iterators,
      ticket: session.ticket,
    });
  });
}
