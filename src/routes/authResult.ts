import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config.ts";
import { errorBody, isErrorCode, sendError } from "../errors.ts";
import { encryptResult } from "../crypto.ts";
import { buildResultJson } from "../identity.ts";
import {
  isAuthWindowExpired,
  isTokenExpired,
  loadByAccessToken,
  loadByRequestNo,
  updateSession,
} from "../store.ts";

const ROUTE_PATH = "/ido/intc/v1.0/auth/result";

// Sentinel produced by the scoped JSON parser when the payload is not
// parseable JSON. The handler maps it to 3001 (HTTP 200) instead of
// Fastify's default 400 so the mock matches the ResultCode table
// (3xxx -> 200). Mechanism mirrored from src/routes/authToken.ts.
const JSON_PARSE_FAILED: unique symbol = Symbol("nice-mock-json-parse-failed");

interface AuthResultBody {
  request_no: unknown;
  transaction_id: unknown;
  web_transaction_id: unknown;
}

function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length).trim();
  return token === "" ? undefined : token;
}

function errorCodeOf(error: unknown): string | undefined {
  const code: unknown = (error as unknown as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorStatusOf(error: unknown): number | undefined {
  const status: unknown = (error as unknown as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    // 1. Bearer checks, identical to the token/url routes: missing or
    // unknown token -> 400/1004; expired -> 400/1003.
    const token = extractBearer(request);
    if (token === undefined) {
      return sendError(reply, "1004");
    }
    const tokenSession = loadByAccessToken(token);
    if (tokenSession === undefined) {
      return sendError(reply, "1004");
    }
    if (isTokenExpired(tokenSession)) {
      return sendError(reply, "1003");
    }

    // 2. Body: JSON object (or the form-urlencoded fallback registered in
    // app.ts). Anything else -> 3001 (HTTP 200).
    const rawBody: unknown = request.body;
    if (!isRecord(rawBody) || rawBody === (JSON_PARSE_FAILED as unknown as Record<string, unknown>)) {
      return reply.code(200).send(errorBody("3001"));
    }
    const body = rawBody as Partial<AuthResultBody> & Record<string, unknown>;

    // 3. request_no validation BEFORE the session lookup: malformed IDs get
    // 1002, well-formed-but-unknown IDs get 3029.
    const requestNo: unknown = body["request_no"];
    if (typeof requestNo !== "string" || requestNo.length < 20 || requestNo.length > 50) {
      return sendError(reply, "1002");
    }
    const transactionId: unknown = body["transaction_id"];
    if (typeof transactionId !== "string" || transactionId === "") {
      return sendError(reply, "1002");
    }
    const webTransactionId: unknown = body["web_transaction_id"];
    if (typeof webTransactionId !== "string" || webTransactionId === "") {
      return sendError(reply, "1002");
    }

    // 4. Session lookup by request_no.
    const session = loadByRequestNo(requestNo);
    if (session === undefined) {
      return sendError(reply, "3029");
    }
    if (session.transactionId === undefined || transactionId !== session.transactionId) {
      return sendError(reply, "3029");
    }
    if (isAuthWindowExpired(session)) {
      return sendError(reply, "3032");
    }
    if (session.status === "FAILED") {
      const failCode: string = session.failCode ?? "3032";
      return sendError(reply, isErrorCode(failCode) ? failCode : "3032");
    }
    if (session.status !== "SUCCESS") {
      return sendError(reply, "3032");
    }
    if (session.webTransactionId === undefined || webTransactionId !== session.webTransactionId) {
      return sendError(reply, "3032");
    }

    const config = loadConfig();
    if (config.strictOneTimeResult && session.resultFetchedAt !== undefined) {
      return sendError(reply, "3033");
    }

    // 5. Success: encrypt the exact result JSON; never emit plaintext.
    if (session.identity === undefined) {
      return sendError(reply, "3032");
    }
    const json = JSON.stringify(buildResultJson(session.identity, session.clientId));
    const { encData, integrityValue } = encryptResult(json, {
      ticket: session.ticket,
      iterators: session.iterators,
      transactionId: session.transactionId,
    });
    updateSession(session.requestNo, { resultFetchedAt: Date.now() });

    return reply.code(200).send({
      result_code: "0000",
      result_message: "응답성공",
      enc_data: encData,
      integrity_value: integrityValue,
    });
  });
}
