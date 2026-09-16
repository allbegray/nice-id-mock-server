import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { createClient, deleteClient } from "../src/clients.ts";
import { getDb } from "../src/db.ts";
import { loadByAccessToken } from "../src/store.ts";
import { initTestDb, closeTestDb } from "./helpers/testDb.ts";

// NOTE: there is intentionally no "DB uninitialized" case — session creation
// itself requires the DB, so the route cannot serve any request without it.
const PATH = "/ido/intc/v1.0/auth/token";
const REQUEST_NO = "REQ12345678901234567890";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64url")}`;
}

function validHeaders(): Record<string, string> {
  return {
    authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
    "content-type": "application/json",
  };
}

function validPayload(requestNo: string = REQUEST_NO): Record<string, string> {
  return { grant_type: "client_credentials", request_no: requestNo };
}

interface TokenSuccess {
  result_code: string;
  result_message: string;
  request_no: string;
  access_token: string;
  expires_in: number;
  token_type: string;
  iterators: number;
  ticket: string;
}

interface JwtPayload {
  clientId: string;
}

function decodeJwtPayload(accessToken: string): JwtPayload {
  const parts = accessToken.split(".");
  assert.equal(parts.length, 3);
  return JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as JwtPayload;
}

function selectSessionClientId(requestNo: string): string | undefined {
  const row = getDb()
    .prepare("SELECT client_id FROM sessions WHERE request_no = ?")
    .get(requestNo) as { client_id: string } | undefined;
  return row?.client_id;
}

describe("POST /ido/intc/v1.0/auth/token", () => {
  beforeEach(() => {
    initTestDb();
    createClient(CLIENT_ID, CLIENT_SECRET);
  });

  afterEach(() => {
    delete process.env["STRICT_CREDENTIALS"];
    closeTestDb();
  });

  it("happy path: returns the exact 0000 field set with valid types", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: validHeaders(),
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as TokenSuccess;
      assert.deepEqual(Object.keys(body).sort(), [
        "access_token",
        "expires_in",
        "iterators",
        "request_no",
        "result_code",
        "result_message",
        "ticket",
        "token_type",
      ]);
      assert.equal(body.result_code, "0000");
      assert.equal(body.result_message, "응답성공");
      assert.equal(body.request_no, REQUEST_NO);
      assert.equal(typeof body.access_token, "string");
      assert.equal(body.access_token.split(".").length, 3);
      assert.equal(typeof body.expires_in, "number");
      assert.ok(Math.abs(body.expires_in - (Date.now() + 86400000)) < 5000);
      assert.equal(body.token_type, "Bearer");
      assert.equal(typeof body.iterators, "number");
      assert.equal(body.iterators, 66);
      assert.match(body.ticket, /^[A-Za-z0-9_-]{56}$/);
    } finally {
      await app.close();
    }
  });

  it("repeat call rotates ticket/iterators/accessToken and invalidates the old token", async () => {
    const app = buildApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: PATH,
        headers: validHeaders(),
        payload: validPayload(),
      });
      const firstBody = first.json() as TokenSuccess;
      const second = await app.inject({
        method: "POST",
        url: PATH,
        headers: validHeaders(),
        payload: validPayload(),
      });
      assert.equal(second.statusCode, 200);
      const secondBody = second.json() as TokenSuccess;
      assert.equal(secondBody.result_code, "0000");
      assert.notEqual(secondBody.access_token, firstBody.access_token);
      assert.notEqual(secondBody.ticket, firstBody.ticket);
      // Old Bearer must resolve unknown (downstream 1004), new one resolves.
      assert.equal(loadByAccessToken(firstBody.access_token), undefined);
      assert.equal(loadByAccessToken(secondBody.access_token)?.requestNo, REQUEST_NO);
    } finally {
      await app.close();
    }
  });

  it("missing Authorization header -> 400/1001", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: { "content-type": "application/json" },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { result_code: string }).result_code, "1001");
    } finally {
      await app.close();
    }
  });

  it("malformed Authorization header variants -> 400/1001", async () => {
    const app = buildApp();
    try {
      for (const authorization of [
        "Bearer sometoken",
        "Basic",
        "Basic ",
        "Basic !!!not-base64url!!!",
        `Basic ${Buffer.from("no-colon-here", "utf8").toString("base64url")}`,
        `Basic ${Buffer.from(":only-secret", "utf8").toString("base64url")}`,
      ]) {
        const res = await app.inject({
          method: "POST",
          url: PATH,
          headers: { authorization, "content-type": "application/json" },
          payload: validPayload(),
        });
        assert.equal(res.statusCode, 400, `expected 400 for ${authorization}`);
        assert.equal(
          (res.json() as { result_code: string }).result_code,
          "1001",
          `expected 1001 for ${authorization}`,
        );
      }
    } finally {
      await app.close();
    }
  });

  it("wrong secret with STRICT_CREDENTIALS=true -> 400/1006", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: basicAuth(CLIENT_ID, "wrong-secret"),
          "content-type": "application/json",
        },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { result_code: string }).result_code, "1006");
    } finally {
      await app.close();
    }
  });

  it("STRICT_CREDENTIALS=false accepts any well-formed Basic pair", async () => {
    process.env["STRICT_CREDENTIALS"] = "false";
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: basicAuth("any-id", "any-secret"),
          "content-type": "application/json",
        },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { result_code: string }).result_code, "0000");
    } finally {
      await app.close();
    }
  });

  it("short request_no -> 400/1002", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: validHeaders(),
        payload: { grant_type: "client_credentials", request_no: "short" },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { result_code: string }).result_code, "1002");
    } finally {
      await app.close();
    }
  });

  it("long request_no (51 chars) -> 400/1002", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: validHeaders(),
        payload: { grant_type: "client_credentials", request_no: "R".repeat(51) },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { result_code: string }).result_code, "1002");
    } finally {
      await app.close();
    }
  });

  it("bad grant_type -> 400/1002", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: validHeaders(),
        payload: { grant_type: "authorization_code", request_no: REQUEST_NO },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { result_code: string }).result_code, "1002");
    } finally {
      await app.close();
    }
  });

  it("garbage JSON body -> 200/3001", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
          "content-type": "application/json",
        },
        payload: "not-json{{{",
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { result_code: string }).result_code, "3001");
    } finally {
      await app.close();
    }
  });

  it("form-urlencoded body works via the registered fallback", async () => {
    const app = buildApp();
    try {
      const params = new URLSearchParams({
        grant_type: "client_credentials",
        request_no: REQUEST_NO,
      });
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: params.toString(),
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { result_code: string }).result_code, "0000");
      assert.equal((res.json() as TokenSuccess).request_no, REQUEST_NO);
    } finally {
      await app.close();
    }
  });

  it("DB-seeded non-default client -> 0000 with presented id in JWT and sessions.client_id", async () => {
    const presentedId = "presented-client-id";
    createClient(presentedId, "presented-secret");
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: basicAuth(presentedId, "presented-secret"),
          "content-type": "application/json",
        },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as TokenSuccess;
      assert.equal(body.result_code, "0000");
      assert.equal(decodeJwtPayload(body.access_token).clientId, presentedId);
      assert.equal(selectSessionClientId(REQUEST_NO), presentedId);
    } finally {
      await app.close();
    }
  });

  it("deleted client -> 400/1006", async () => {
    assert.equal(deleteClient(CLIENT_ID), true);
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: validHeaders(),
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { result_code: string }).result_code, "1006");
    } finally {
      await app.close();
    }
  });

  it("STRICT_CREDENTIALS=false with empty clients table -> 200/0000", async () => {
    process.env["STRICT_CREDENTIALS"] = "false";
    assert.equal(deleteClient(CLIENT_ID), true);
    const count = getDb().prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number };
    assert.equal(count.n, 0);
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: basicAuth("ghost-id", "ghost-secret"),
          "content-type": "application/json",
        },
        payload: validPayload(),
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { result_code: string }).result_code, "0000");
    } finally {
      await app.close();
    }
  });
});
