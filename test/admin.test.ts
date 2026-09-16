import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { closeTestDb, initTestDb } from "./helpers/testDb.ts";

const LIST_PATH = "/admin/clients";

function clientPath(clientId: string): string {
  return `/admin/clients/${clientId}`;
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

interface CreatedClient {
  clientId: string;
  clientSecret: string;
  createdAt: number;
  updatedAt: number;
}

interface MaskedClient {
  clientId: string;
  clientSecretMasked: string;
  createdAt: number;
  updatedAt: number;
}

interface AdminErrorBody {
  error: string;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.ok(value !== null);
  return value as Record<string, unknown>;
}

function asCreated(value: unknown): CreatedClient {
  const body = asRecord(value);
  assert.deepEqual(Object.keys(body).sort(), [
    "clientId",
    "clientSecret",
    "createdAt",
    "updatedAt",
  ]);
  assert.equal(typeof body["clientId"], "string");
  assert.equal(typeof body["clientSecret"], "string");
  assert.equal(typeof body["createdAt"], "number");
  assert.equal(typeof body["updatedAt"], "number");
  return {
    clientId: body["clientId"] as string,
    clientSecret: body["clientSecret"] as string,
    createdAt: body["createdAt"] as number,
    updatedAt: body["updatedAt"] as number,
  };
}

function asMasked(value: unknown): MaskedClient {
  const body = asRecord(value);
  assert.deepEqual(Object.keys(body).sort(), [
    "clientId",
    "clientSecretMasked",
    "createdAt",
    "updatedAt",
  ]);
  assert.equal(typeof body["clientId"], "string");
  assert.equal(typeof body["clientSecretMasked"], "string");
  assert.equal(typeof body["createdAt"], "number");
  assert.equal(typeof body["updatedAt"], "number");
  assert.ok(!("clientSecret" in body));
  return {
    clientId: body["clientId"] as string,
    clientSecretMasked: body["clientSecretMasked"] as string,
    createdAt: body["createdAt"] as number,
    updatedAt: body["updatedAt"] as number,
  };
}

function asAdminError(value: unknown, expectedError: string): AdminErrorBody {
  const body = asRecord(value);
  assert.equal(body["error"], expectedError);
  assert.equal(typeof body["message"], "string");
  assert.ok(!("result_code" in body));
  return { error: body["error"] as string, message: body["message"] as string };
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64url")}`;
}

describe("admin client CRUD", () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it("full CRUD matrix: create 201 -> list masked -> get masked -> PUT -> DELETE 204", async () => {
    const app = buildApp();
    try {
      const createdRes = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "crud-client", clientSecret: "aaaa-secret-1" },
      });
      assert.equal(createdRes.statusCode, 201);
      const created = asCreated(createdRes.json());
      assert.equal(created.clientId, "crud-client");
      assert.equal(created.clientSecret, "aaaa-secret-1");

      const listRes = await app.inject({ method: "GET", url: LIST_PATH });
      assert.equal(listRes.statusCode, 200);
      const listBody = asRecord(listRes.json());
      assert.deepEqual(Object.keys(listBody), ["clients"]);
      assert.ok(Array.isArray(listBody["clients"]));
      const listed = (listBody["clients"] as unknown[]).map(asMasked);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.clientId, "crud-client");
      assert.equal(listed[0]?.clientSecretMasked, "aaaa****");

      const getRes = await app.inject({ method: "GET", url: clientPath("crud-client") });
      assert.equal(getRes.statusCode, 200);
      const fetched = asMasked(getRes.json());
      assert.equal(fetched.clientId, "crud-client");
      assert.equal(fetched.clientSecretMasked, "aaaa****");
      assert.equal(fetched.createdAt, created.createdAt);

      const putRes = await app.inject({
        method: "PUT",
        url: clientPath("crud-client"),
        headers: jsonHeaders(),
        payload: { clientSecret: "bbbb-secret-2" },
      });
      assert.equal(putRes.statusCode, 200);
      const updated = asMasked(putRes.json());
      assert.equal(updated.clientId, "crud-client");
      assert.equal(updated.clientSecretMasked, "bbbb****");
      assert.equal(updated.createdAt, created.createdAt);
      assert.ok(updated.updatedAt >= created.updatedAt);

      const deleteRes = await app.inject({ method: "DELETE", url: clientPath("crud-client") });
      assert.equal(deleteRes.statusCode, 204);
      assert.equal(deleteRes.body, "");

      const getAfterDelete = await app.inject({ method: "GET", url: clientPath("crud-client") });
      assert.equal(getAfterDelete.statusCode, 404);
      asAdminError(getAfterDelete.json(), "not_found");

      const listAfterDelete = await app.inject({ method: "GET", url: LIST_PATH });
      assert.equal(listAfterDelete.statusCode, 200);
      assert.deepEqual(asRecord(listAfterDelete.json())["clients"] as unknown[], []);
    } finally {
      await app.close();
    }
  });

  it("list orders by client_id", async () => {
    const app = buildApp();
    try {
      for (const id of ["c-id", "a-id", "b-id"]) {
        const res = await app.inject({
          method: "POST",
          url: LIST_PATH,
          headers: jsonHeaders(),
          payload: { clientId: id, clientSecret: "some-secret-1" },
        });
        assert.equal(res.statusCode, 201);
      }
      const listRes = await app.inject({ method: "GET", url: LIST_PATH });
      assert.equal(listRes.statusCode, 200);
      const clients = asRecord(listRes.json())["clients"] as unknown[];
      assert.deepEqual(
        clients.map((entry) => asMasked(entry).clientId),
        ["a-id", "b-id", "c-id"],
      );
    } finally {
      await app.close();
    }
  });

  it("masking rule: len<=4 secret yields ****", async () => {
    const app = buildApp();
    try {
      const createdRes = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "short-secret", clientSecret: "ab" },
      });
      assert.equal(createdRes.statusCode, 201);
      const getRes = await app.inject({ method: "GET", url: clientPath("short-secret") });
      assert.equal(getRes.statusCode, 200);
      assert.equal(asMasked(getRes.json()).clientSecretMasked, "****");
    } finally {
      await app.close();
    }
  });

  it("POST clientId with colon -> 400 bad_request", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "a:b", clientSecret: "valid-secret-1" },
      });
      assert.equal(res.statusCode, 400);
      asAdminError(res.json(), "bad_request");
    } finally {
      await app.close();
    }
  });

  it("POST empty secret -> 400 bad_request", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "empty-secret-id", clientSecret: "" },
      });
      assert.equal(res.statusCode, 400);
      asAdminError(res.json(), "bad_request");
    } finally {
      await app.close();
    }
  });

  it("POST whitespace secret -> 400 bad_request", async () => {
    const app = buildApp();
    try {
      for (const secret of ["has space", "tab\there", "new\nline"]) {
        const res = await app.inject({
          method: "POST",
          url: LIST_PATH,
          headers: jsonHeaders(),
          payload: { clientId: "ws-secret-id", clientSecret: secret },
        });
        assert.equal(res.statusCode, 400);
        asAdminError(res.json(), "bad_request");
      }
    } finally {
      await app.close();
    }
  });

  it("POST missing fields -> 400 bad_request", async () => {
    const app = buildApp();
    try {
      const cases: Record<string, unknown>[] = [
        {},
        { clientId: "only-id" },
        { clientSecret: "only-secret-1" },
      ];
      for (const payload of cases) {
        const res = await app.inject({
          method: "POST",
          url: LIST_PATH,
          headers: jsonHeaders(),
          payload,
        });
        assert.equal(res.statusCode, 400);
        asAdminError(res.json(), "bad_request");
      }
    } finally {
      await app.close();
    }
  });

  it("POST non-object body (array) -> 400 bad_request", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: ["not", "an", "object"],
      });
      assert.equal(res.statusCode, 400);
      asAdminError(res.json(), "bad_request");
    } finally {
      await app.close();
    }
  });

  it("POST malformed JSON -> 400 bad_request (never 3001, never NICE envelope)", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: "not-json{{{",
      });
      assert.equal(res.statusCode, 400);
      asAdminError(res.json(), "bad_request");
    } finally {
      await app.close();
    }
  });

  it("POST unsupported content-type -> 400 bad_request", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: { "content-type": "text/plain" },
        payload: "clientId=x&clientSecret=y",
      });
      assert.equal(res.statusCode, 400);
      asAdminError(res.json(), "bad_request");
    } finally {
      await app.close();
    }
  });

  it("PUT validation failures -> 400 bad_request", async () => {
    const app = buildApp();
    try {
      const createdRes = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "put-target", clientSecret: "cccc-secret-1" },
      });
      assert.equal(createdRes.statusCode, 201);

      for (const payload of [{ clientSecret: "" }, { clientSecret: "bad secret" }, {}]) {
        const res = await app.inject({
          method: "PUT",
          url: clientPath("put-target"),
          headers: jsonHeaders(),
          payload,
        });
        assert.equal(res.statusCode, 400);
        asAdminError(res.json(), "bad_request");
      }

      const arrayRes = await app.inject({
        method: "PUT",
        url: clientPath("put-target"),
        headers: jsonHeaders(),
        payload: ["array"],
      });
      assert.equal(arrayRes.statusCode, 400);
      asAdminError(arrayRes.json(), "bad_request");
    } finally {
      await app.close();
    }
  });

  it("path param failing the regex -> 400 bad_request (get/put/delete)", async () => {
    const app = buildApp();
    try {
      const getRes = await app.inject({ method: "GET", url: clientPath("a:b") });
      assert.equal(getRes.statusCode, 400);
      asAdminError(getRes.json(), "bad_request");

      const putRes = await app.inject({
        method: "PUT",
        url: clientPath("a:b"),
        headers: jsonHeaders(),
        payload: { clientSecret: "valid-secret-1" },
      });
      assert.equal(putRes.statusCode, 400);
      asAdminError(putRes.json(), "bad_request");

      const deleteRes = await app.inject({ method: "DELETE", url: clientPath("a:b") });
      assert.equal(deleteRes.statusCode, 400);
      asAdminError(deleteRes.json(), "bad_request");
    } finally {
      await app.close();
    }
  });

  it("get/put/delete on missing client -> 404 not_found", async () => {
    const app = buildApp();
    try {
      const getRes = await app.inject({ method: "GET", url: clientPath("ghost-get") });
      assert.equal(getRes.statusCode, 404);
      asAdminError(getRes.json(), "not_found");

      const putRes = await app.inject({
        method: "PUT",
        url: clientPath("ghost-put"),
        headers: jsonHeaders(),
        payload: { clientSecret: "valid-secret-1" },
      });
      assert.equal(putRes.statusCode, 404);
      asAdminError(putRes.json(), "not_found");

      const deleteRes = await app.inject({ method: "DELETE", url: clientPath("ghost-del") });
      assert.equal(deleteRes.statusCode, 404);
      asAdminError(deleteRes.json(), "not_found");
    } finally {
      await app.close();
    }
  });

  it("duplicate create -> 409 conflict, original row untouched", async () => {
    const app = buildApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "dup-id", clientSecret: "dddd-secret-1" },
      });
      assert.equal(first.statusCode, 201);

      const second = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "dup-id", clientSecret: "eeee-secret-2" },
      });
      assert.equal(second.statusCode, 409);
      asAdminError(second.json(), "conflict");

      const getRes = await app.inject({ method: "GET", url: clientPath("dup-id") });
      assert.equal(getRes.statusCode, 200);
      assert.equal(asMasked(getRes.json()).clientSecretMasked, "dddd****");
    } finally {
      await app.close();
    }
  });

  it("integration: create -> authToken 0000 -> PUT rotates -> DELETE, live Bearer survives (truth-table 4)", async () => {
    const TOKEN_PATH = "/ido/intc/v1.0/auth/token";
    const URL_PATH = "/ido/intc/v1.0/auth/url";
    const REQ_OLD = "admin-integ-req-000001";
    const REQ_NEW = "admin-integ-req-000002";
    const REQ_DEAD = "admin-integ-req-000003";
    const app: FastifyInstance = buildApp();
    try {
      const createdRes = await app.inject({
        method: "POST",
        url: LIST_PATH,
        headers: jsonHeaders(),
        payload: { clientId: "integ-client", clientSecret: "integ-secret-1" },
      });
      assert.equal(createdRes.statusCode, 201);

      const tokenOldRes = await app.inject({
        method: "POST",
        url: TOKEN_PATH,
        headers: { authorization: basicAuth("integ-client", "integ-secret-1"), ...jsonHeaders() },
        payload: { grant_type: "client_credentials", request_no: REQ_OLD },
      });
      assert.equal(tokenOldRes.statusCode, 200);
      assert.equal(asRecord(tokenOldRes.json())["result_code"], "0000");

      const putRes = await app.inject({
        method: "PUT",
        url: clientPath("integ-client"),
        headers: jsonHeaders(),
        payload: { clientSecret: "integ-secret-2" },
      });
      assert.equal(putRes.statusCode, 200);

      const staleRes = await app.inject({
        method: "POST",
        url: TOKEN_PATH,
        headers: { authorization: basicAuth("integ-client", "integ-secret-1"), ...jsonHeaders() },
        payload: { grant_type: "client_credentials", request_no: REQ_OLD },
      });
      assert.equal(staleRes.statusCode, 400);
      assert.equal(asRecord(staleRes.json())["result_code"], "1006");

      const tokenNewRes = await app.inject({
        method: "POST",
        url: TOKEN_PATH,
        headers: { authorization: basicAuth("integ-client", "integ-secret-2"), ...jsonHeaders() },
        payload: { grant_type: "client_credentials", request_no: REQ_NEW },
      });
      assert.equal(tokenNewRes.statusCode, 200);
      const tokenNewBody = asRecord(tokenNewRes.json());
      assert.equal(tokenNewBody["result_code"], "0000");
      const liveBearer = tokenNewBody["access_token"] as string;
      assert.equal(typeof liveBearer, "string");

      const deleteRes = await app.inject({ method: "DELETE", url: clientPath("integ-client") });
      assert.equal(deleteRes.statusCode, 204);

      const deadRes = await app.inject({
        method: "POST",
        url: TOKEN_PATH,
        headers: { authorization: basicAuth("integ-client", "integ-secret-2"), ...jsonHeaders() },
        payload: { grant_type: "client_credentials", request_no: REQ_DEAD },
      });
      assert.equal(deadRes.statusCode, 400);
      assert.equal(asRecord(deadRes.json())["result_code"], "1006");

      // Pre-delete Bearer still resolves via /auth/url (live-token survival).
      const urlRes = await app.inject({
        method: "POST",
        url: URL_PATH,
        headers: { authorization: `Bearer ${liveBearer}`, ...jsonHeaders() },
        payload: {
          request_no: REQ_NEW,
          return_url: "http://127.0.0.1:8080/cb",
          svc_types: ["M"],
          method_type: "GET",
        },
      });
      assert.equal(urlRes.statusCode, 200);
      assert.equal(asRecord(urlRes.json())["result_code"], "0000");
    } finally {
      await app.close();
    }
  });
});

import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_HTML_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "web",
  "admin.html",
);

describe("admin management page", () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it("GET /admin -> 200 text/html with all markers and absolute API path", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/admin" });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers["content-type"]).includes("text/html"));
      const html = res.body;
      for (const marker of [
        'id="warningBanner"',
        'id="clientList"',
        'id="createForm"',
        'id="errorBox"',
        "/admin/clients",
      ]) {
        assert.ok(html.includes(marker), `missing marker: ${marker}`);
      }
      assert.ok(
        html.includes('"/admin/clients"'),
        "page must call the absolute path /admin/clients",
      );
      assert.ok(
        !html.includes('"clients"') && !html.includes("'clients'"),
        "page must not fetch a relative clients path",
      );
      assert.ok(html.includes("prompt("), "edit must use prompt()");
      assert.ok(html.includes("confirm("), "delete must use confirm()");
    } finally {
      await app.close();
    }
  });

  it("admin.html uses no innerHTML interpolation", async () => {
    const html = await readFile(ADMIN_HTML_PATH, "utf8");
    assert.equal(html.split("innerHTML").length - 1, 0);
  });

  it("GET /admin with missing admin.html -> 500 HTML", async () => {
    const backupPath = `${ADMIN_HTML_PATH}.test-bak`;
    await rename(ADMIN_HTML_PATH, backupPath);
    try {
      const app = buildApp();
      try {
        const res = await app.inject({ method: "GET", url: "/admin" });
        assert.equal(res.statusCode, 500);
        assert.ok(String(res.headers["content-type"]).includes("text/html"));
      } finally {
        await app.close();
      }
    } finally {
      await rename(backupPath, ADMIN_HTML_PATH);
    }
  });
});
