import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { createSession, loadByCertId, loadByRequestNo } from "../src/store.ts";
import { initTestDb, closeTestDb } from "./helpers/testDb.ts";

const REQUEST_NO = "REQ12345678901234567890";
const OTHER_REQUEST_NO = "REQ09876543210987654321";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_no: REQUEST_NO,
    return_url: "https://merchant.example.com/nice-id/return?requestNo=" + REQUEST_NO,
    svc_types: ["M"],
    method_type: "GET",
    exp_mods: [],
    ...overrides,
  };
}

describe("POST /ido/intc/v1.0/auth/url", () => {
  let savedPublicBaseUrl: string | undefined;
  let savedAuthUrlTtlMs: string | undefined;

  before(() => {
    savedPublicBaseUrl = process.env["PUBLIC_BASE_URL"];
    savedAuthUrlTtlMs = process.env["AUTH_URL_TTL_MS"];
    process.env["PUBLIC_BASE_URL"] = "http://localhost:8891";
    process.env["AUTH_URL_TTL_MS"] = "600000";
  });

  after(() => {
    if (savedPublicBaseUrl === undefined) {
      delete process.env["PUBLIC_BASE_URL"];
    } else {
      process.env["PUBLIC_BASE_URL"] = savedPublicBaseUrl;
    }
    if (savedAuthUrlTtlMs === undefined) {
      delete process.env["AUTH_URL_TTL_MS"];
    } else {
      process.env["AUTH_URL_TTL_MS"] = savedAuthUrlTtlMs;
    }
  });

  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it("happy path: 0000 with exact fields, session updated, request_no echoed", async () => {
    const app = buildApp();
    try {
      const session = createSession(REQUEST_NO);
      const before = Date.now();
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody(),
      });
      const after = Date.now();

      assert.equal(response.statusCode, 200);
      const body = response.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), [
        "auth_url",
        "request_no",
        "result_code",
        "result_message",
        "transaction_id",
      ]);
      assert.equal(body["result_code"], "0000");
      assert.equal(body["result_message"], "응답성공");
      assert.equal(body["request_no"], REQUEST_NO);
      assert.match(body["auth_url"] as string, /^http:\/\/localhost:8891\/ido\/cert\/request\/S[0-9a-f-]{36}$/);
      assert.match(body["transaction_id"] as string, /^[A-Za-z0-9_-]{56}$/);

      const stored = loadByRequestNo(REQUEST_NO);
      assert.ok(stored !== undefined);
      assert.equal(stored.status, "PENDING");
      assert.equal(stored.transactionId, body["transaction_id"]);
      assert.equal(stored.returnUrl, validBody()["return_url"]);
      assert.deepEqual(stored.svcTypes, ["M"]);
      assert.equal(stored.methodType, "GET");
      assert.deepEqual(stored.expMods, []);
      assert.ok(stored.certId !== undefined);
      assert.ok(
        (stored.authUrlExpiresAt ?? 0) >= before + 600000 &&
          (stored.authUrlExpiresAt ?? 0) <= after + 600000,
      );
      assert.equal(
        (body["auth_url"] as string).split("/").at(-1),
        stored.certId,
      );
      assert.equal(loadByCertId(stored.certId ?? "")?.requestNo, REQUEST_NO);
    } finally {
      await app.close();
    }
  });

  it("repeat issuance rotates certId/transaction_id and invalidates the old certId", async () => {
    const app = buildApp();
    try {
      const session = createSession(REQUEST_NO);
      const first = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody(),
      });
      const firstBody = first.json() as Record<string, unknown>;
      const firstCertId = (firstBody["auth_url"] as string).split("/").at(-1) ?? "";

      const second = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody(),
      });
      assert.equal(second.statusCode, 200);
      const secondBody = second.json() as Record<string, unknown>;
      const secondCertId = (secondBody["auth_url"] as string).split("/").at(-1) ?? "";

      assert.notEqual(secondBody["transaction_id"], firstBody["transaction_id"]);
      assert.notEqual(secondCertId, firstCertId);
      assert.equal(loadByCertId(firstCertId), undefined);
      assert.equal(loadByCertId(secondCertId)?.requestNo, REQUEST_NO);
    } finally {
      await app.close();
    }
  });

  it("unknown bearer -> 400/1004", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: "Bearer not-a-real-token" },
        payload: validBody(),
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        result_code: "1004",
        result_message: "유효한 접근 토큰 아님",
      });
    } finally {
      await app.close();
    }
  });

  it("missing bearer -> 400/1004", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        payload: validBody(),
      });
      assert.equal(response.statusCode, 400);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "1004");
    } finally {
      await app.close();
    }
  });

  it("expired bearer -> 400/1003", async () => {
    const app = buildApp();
    try {
      const session = createSession(REQUEST_NO, { tokenTtlMs: 0 });
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody(),
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        result_code: "1003",
        result_message: "접근 토큰 만료 오류",
      });
    } finally {
      await app.close();
    }
  });

  it("relative return_url -> 400/1002", async () => {
    const app = buildApp();
    try {
      const session = createSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody({ return_url: "/relative" }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "1002");
    } finally {
      await app.close();
    }
  });

  it("empty svc_types -> 400/1002", async () => {
    const app = buildApp();
    try {
      const session = createSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody({ svc_types: [] }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "1002");
    } finally {
      await app.close();
    }
  });

  it("request_no/token mismatch -> 400/1004", async () => {
    const app = buildApp();
    try {
      const sessionA = createSession(REQUEST_NO);
      createSession(OTHER_REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${sessionA.accessToken}` },
        payload: validBody({ request_no: OTHER_REQUEST_NO }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "1004");
    } finally {
      await app.close();
    }
  });

  it("invalid method_type and bad close_url -> 400/1002", async () => {
    const app = buildApp();
    try {
      const session = createSession(REQUEST_NO);
      const badMethod = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody({ method_type: "PUT" }),
      });
      assert.equal(badMethod.statusCode, 400);
      assert.equal((badMethod.json() as Record<string, unknown>)["result_code"], "1002");

      const badClose = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody({ close_url: "/relative-close" }),
      });
      assert.equal(badClose.statusCode, 400);
      assert.equal((badClose.json() as Record<string, unknown>)["result_code"], "1002");
    } finally {
      await app.close();
    }
  });

  it("short request_no -> 400/1002", async () => {
    const app = buildApp();
    try {
      const session = createSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/url",
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: validBody({ request_no: "short" }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "1002");
    } finally {
      await app.close();
    }
  });
});
