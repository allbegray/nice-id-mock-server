import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createClient,
  deleteClient,
  findClient,
  listClients,
  maskSecret,
  updateClientSecret,
} from "../clients.ts";
import type { Client } from "../types.ts";
import { readAdminHtml } from "../app.ts";

// Runtime client-credential CRUD for the local-only mock tool.
//
// NO authentication on these routes by design: this server is a local dev
// tool (never exposed), and the admin API exists so tests and operators can
// rotate credentials without restarting the process.
//
// Error vocabulary is EXACTLY bad_request / not_found / conflict with plain
// `{error, message}` bodies. The NICE `result_code` envelope (see
// src/errors.ts) is NEVER used here.
//
// Deletion does NOT revoke already-issued tokens: sessions live in their own
// table and stay valid until their own TTL expires (truth-table cell 4).

// Sentinel produced by the scoped JSON parser when the payload is not
// parseable JSON. Handlers map it to 400 bad_request.
const JSON_PARSE_FAILED: unique symbol = Symbol("admin-json-parse-failed");

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// `:` is forbidden in clientIds because Basic auth splits credentials on the
// first colon; it IS allowed inside secrets (the split happens before it).
function isValidClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

function isValidClientSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\s\x00-\x1f\x7f]/.test(value)
  );
}

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

type AdminError = "bad_request" | "not_found" | "conflict";

function sendAdminError(reply: FastifyReply, status: number, error: AdminError, message: string): FastifyReply {
  return reply.code(status).send({ error, message });
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return sendAdminError(reply, 400, "bad_request", message);
}

function notFound(reply: FastifyReply, message: string): FastifyReply {
  return sendAdminError(reply, 404, "not_found", message);
}

interface MaskedClient {
  clientId: string;
  clientSecretMasked: string;
  createdAt: number;
  updatedAt: number;
}

function toMasked(client: Client): MaskedClient {
  return {
    clientId: client.clientId,
    clientSecretMasked: maskSecret(client.clientSecret),
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

function paramClientId(request: FastifyRequest): unknown {
  return (request.params as { clientId?: unknown }).clientId;
}

export default async function routes(app: FastifyInstance): Promise<void> {
  // Plugin-SCOPED JSON parser + error handler (mirrors
  // src/routes/authToken.ts:31-58 with the admin error vocabulary).
  // Fastify plugin encapsulation keeps this from leaking into /ido routes:
  // malformed JSON here yields 400 bad_request, never 3001 and never the
  // NICE envelope.
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

  // Unsupported Content-Type (415 / FST_ERR_CTP_INVALID_MEDIA_TYPE) maps to
  // 400 bad_request on admin routes.
  app.setErrorHandler((error, _request, reply) => {
    const code = errorCodeOf(error);
    if (
      errorStatusOf(error) === 415 ||
      code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
      code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      badRequest(reply, "unsupported content type or empty body");
      return;
    }
    reply.send(error);
  });

  app.get("/admin/clients", async (_request, reply) => {
    const clients = listClients().map(toMasked);
    return reply.code(200).send({ clients });
  });

  app.get("/admin", async (_request, reply) => {
    const html = await readAdminHtml();
    if (html === undefined) {
      return reply
        .code(500)
        .type("text/html; charset=utf-8")
        .send("<h1>관리 페이지를 찾을 수 없습니다</h1>");
    }
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/admin/clients", async (request, reply) => {
    const body: unknown = request.body;
    if (!isRecord(body)) {
      return badRequest(reply, "body must be a JSON object");
    }
    const clientId: unknown = body["clientId"];
    if (!isValidClientId(clientId)) {
      return badRequest(reply, "clientId must match ^[A-Za-z0-9._-]{1,64}$");
    }
    const clientSecret: unknown = body["clientSecret"];
    if (!isValidClientSecret(clientSecret)) {
      return badRequest(
        reply,
        "clientSecret must be 1..128 chars with no whitespace or control chars",
      );
    }
    const created = createClient(clientId, clientSecret);
    if (created === undefined) {
      return sendAdminError(reply, 409, "conflict", `client "${clientId}" already exists`);
    }
    // Full secret is returned HERE ONLY, exactly once at creation.
    return reply.code(201).send({
      clientId: created.clientId,
      clientSecret: created.clientSecret,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  });

  app.get("/admin/clients/:clientId", async (request, reply) => {
    const clientId = paramClientId(request);
    if (!isValidClientId(clientId)) {
      return badRequest(reply, "clientId must match ^[A-Za-z0-9._-]{1,64}$");
    }
    const found = findClient(clientId);
    if (found === undefined) {
      return notFound(reply, `client "${clientId}" not found`);
    }
    return reply.code(200).send(toMasked(found));
  });

  app.put("/admin/clients/:clientId", async (request, reply) => {
    const clientId = paramClientId(request);
    if (!isValidClientId(clientId)) {
      return badRequest(reply, "clientId must match ^[A-Za-z0-9._-]{1,64}$");
    }
    const body: unknown = request.body;
    if (!isRecord(body)) {
      return badRequest(reply, "body must be a JSON object");
    }
    const clientSecret: unknown = body["clientSecret"];
    if (!isValidClientSecret(clientSecret)) {
      return badRequest(
        reply,
        "clientSecret must be 1..128 chars with no whitespace or control chars",
      );
    }
    const updated = updateClientSecret(clientId, clientSecret);
    if (updated === undefined) {
      return notFound(reply, `client "${clientId}" not found`);
    }
    return reply.code(200).send(toMasked(updated));
  });

  app.delete("/admin/clients/:clientId", async (request, reply) => {
    const clientId = paramClientId(request);
    if (!isValidClientId(clientId)) {
      return badRequest(reply, "clientId must match ^[A-Za-z0-9._-]{1,64}$");
    }
    const deleted = deleteClient(clientId);
    if (!deleted) {
      return notFound(reply, `client "${clientId}" not found`);
    }
    // 204 with EMPTY body. Already-issued tokens survive (see module doc).
    return reply.code(204).send();
  });
}
