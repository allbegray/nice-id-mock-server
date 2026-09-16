import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { decryptForTest } from "../src/crypto.ts";
import { deriveCi, deriveDi, RESULT_JSON_KEYS } from "../src/identity.ts";
import { createClient } from "../src/clients.ts";
import { initTestDb, closeTestDb } from "./helpers/testDb.ts";
import { startReturnCatcher } from "./helpers/returnCatcher.ts";
import type { ReturnCatcher } from "./helpers/returnCatcher.ts";

// Full-flow e2e: every step drives REAL HTTP servers via fetch — a live
// Fastify app on an ephemeral port plus a local return_url catcher.
// Each test gets a FRESH app + FRESH store; no inter-test state.

const WAIT_MS = 2000;

function newRequestNo(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`.slice(0, 48);
}

function reqStr(body: Record<string, unknown>, key: string): string {
  const value: unknown = body[key];
  if (typeof value !== "string") {
    throw new Error(`expected string at ${key}, got ${typeof value}`);
  }
  return value;
}

function reqNum(body: Record<string, unknown>, key: string): number {
  const value: unknown = body[key];
  if (typeof value !== "number") {
    throw new Error(`expected number at ${key}, got ${typeof value}`);
  }
  return value;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

interface LiveApp {
  app: FastifyInstance;
  baseUrl: string;
}

// Start the app on an ephemeral port, then rebuild the app config so
// auth_url points at the live test server (routes read loadConfig() per
// request, so publishing PUBLIC_BASE_URL into the environment IS the
// rebuild; the env value is saved/restored per test in beforeEach/afterEach).
async function startApp(): Promise<LiveApp> {
  const app = buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    await app.close();
    throw new Error("test app failed to resolve an ephemeral address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env["PUBLIC_BASE_URL"] = baseUrl;
  return { app, baseUrl };
}

interface TokenIssued {
  accessToken: string;
  ticket: string;
  iterators: number;
}

async function issueToken(baseUrl: string, requestNo: string): Promise<TokenIssued> {
  const config = loadConfig();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64url");
  const res = await fetch(`${baseUrl}/ido/intc/v1.0/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
    body: JSON.stringify({ grant_type: "client_credentials", request_no: requestNo }),
  });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body["result_code"], "0000");
  assert.equal(body["request_no"], requestNo);
  return { accessToken: reqStr(body, "access_token"), ticket: reqStr(body, "ticket"), iterators: reqNum(body, "iterators") };
}

interface UrlIssued {
  authUrl: string;
  transactionId: string;
}

async function issueUrl(
  baseUrl: string,
  accessToken: string,
  requestNo: string,
  returnUrl: string,
  methodType: string,
): Promise<UrlIssued> {
  const res = await fetch(`${baseUrl}/ido/intc/v1.0/auth/url`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      request_no: requestNo,
      return_url: returnUrl,
      svc_types: ["M"],
      method_type: methodType,
    }),
  });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body["result_code"], "0000");
  return { authUrl: reqStr(body, "auth_url"), transactionId: reqStr(body, "transaction_id") };
}

async function callResult(
  baseUrl: string,
  accessToken: string,
  requestNo: string,
  transactionId: string,
  webTransactionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/ido/intc/v1.0/auth/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      request_no: requestNo,
      transaction_id: transactionId,
      web_transaction_id: webTransactionId,
    }),
  });
  return { status: res.status, body: await readJson(res) };
}

// Follow a 302 Location the way a browser would, delivering the callback
// to the catcher, and return the caught request.
async function followRedirectToCatcher(location: string, catcher: ReturnCatcher): Promise<string> {
  const followRes = await fetch(location);
  assert.equal(followRes.status, 200);
  await followRes.text();
  const caught = await catcher.waitForRequest(WAIT_MS);
  assert.equal(caught.method, "GET");
  const webTransactionId = caught.query["web_transaction_id"] ?? "";
  assert.ok(webTransactionId !== "", "catcher GET must carry web_transaction_id");
  return webTransactionId;
}

function assertIdentityPayload(plaintext: string): void {
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  assert.deepEqual([...Object.keys(parsed)].sort(), [...RESULT_JSON_KEYS].sort());
  assert.equal(parsed["name"], "홍길동");
  assert.equal(parsed["birthdate"], "19000208");
  assert.equal(parsed["gender"], "1");
  assert.equal(parsed["national_info"], "0");
  assert.equal(parsed["mobile_co"], "2");
  assert.equal(parsed["mobile_no"], "01012345678");
  const ci = reqStr(parsed, "ci");
  const di = reqStr(parsed, "di");
  assert.equal(ci.length, 86);
  assert.equal(di.length, 86);
  assert.match(ci, /^[A-Za-z0-9_-]+$/);
  assert.match(di, /^[A-Za-z0-9_-]+$/);
  // ci/di stable on re-derivation from the decrypted identity.
  const identity = {
    name: reqStr(parsed, "name"),
    birthdate: reqStr(parsed, "birthdate"),
    gender: reqStr(parsed, "gender"),
    nationalInfo: reqStr(parsed, "national_info"),
    mobileCo: reqStr(parsed, "mobile_co"),
    mobileNo: reqStr(parsed, "mobile_no"),
  };
  assert.equal(deriveCi(identity), ci);
  assert.equal(deriveDi(identity), di);
}

describe("full-flow e2e with return_url catcher", () => {
  let savedPublicBaseUrl: string | undefined;
  let hadPublicBaseUrl = false;

  beforeEach(() => {
    initTestDb();
    createClient("test-client-id", "test-client-secret");
    hadPublicBaseUrl = Object.hasOwn(process.env, "PUBLIC_BASE_URL");
    savedPublicBaseUrl = process.env["PUBLIC_BASE_URL"];
  });

  afterEach(() => {
    if (hadPublicBaseUrl) {
      process.env["PUBLIC_BASE_URL"] = savedPublicBaseUrl ?? "";
    } else {
      delete process.env["PUBLIC_BASE_URL"];
    }
    closeTestDb();
  });

  it("GET flow: token -> url -> auto=1 redirect -> catcher GET -> result decrypts", async () => {
    const { app, baseUrl } = await startApp();
    const catcher = await startReturnCatcher();
    try {
      const requestNo = newRequestNo("REQE2EGET");
      const returnUrl = `${catcher.baseUrl}/nice-id/return?requestNo=${requestNo}`;
      const token = await issueToken(baseUrl, requestNo);
      const issued = await issueUrl(baseUrl, token.accessToken, requestNo, returnUrl, "GET");
      assert.ok(
        issued.authUrl.startsWith(`${baseUrl}/ido/cert/request/S`),
        "auth_url must point at the live test server",
      );

      const pageRes = await fetch(`${issued.authUrl}?auto=1`, { redirect: "manual" });
      assert.equal(pageRes.status, 302);
      const location = pageRes.headers.get("location");
      await pageRes.text();
      assert.ok(location !== null && location !== "", "302 must carry a Location");
      const locationUrl = new URL(location);
      assert.equal(locationUrl.searchParams.get("requestNo"), requestNo);
      const wtidFromLocation = locationUrl.searchParams.get("web_transaction_id") ?? "";
      assert.ok(wtidFromLocation !== "", "Location must carry web_transaction_id");

      const webTransactionId = await followRedirectToCatcher(location, catcher);
      assert.equal(webTransactionId, wtidFromLocation);
      const caught = catcher.requests[catcher.requests.length - 1];
      assert.ok(caught !== undefined);
      assert.equal(caught.query["requestNo"] ?? "", requestNo);

      const result = await callResult(baseUrl, token.accessToken, requestNo, issued.transactionId, webTransactionId);
      assert.equal(result.status, 200);
      assert.equal(result.body["result_code"], "0000");
      const plaintext = decryptForTest(
        token.ticket,
        token.iterators,
        issued.transactionId,
        reqStr(result.body, "enc_data"),
        reqStr(result.body, "integrity_value"),
      );
      assertIdentityPayload(plaintext);
    } finally {
      await catcher.close();
      await app.close();
    }
  });

  it("POST flow: form complete -> auto-submit HTML -> catcher POST -> result decrypts", async () => {
    const { app, baseUrl } = await startApp();
    const catcher = await startReturnCatcher();
    try {
      const requestNo = newRequestNo("REQE2EPOST");
      const returnUrl = `${catcher.baseUrl}/nice-id/return?requestNo=${requestNo}`;
      const token = await issueToken(baseUrl, requestNo);
      const issued = await issueUrl(baseUrl, token.accessToken, requestNo, returnUrl, "POST");
      assert.ok(
        issued.authUrl.startsWith(`${baseUrl}/ido/cert/request/S`),
        "auth_url must point at the live test server",
      );

      const completeRes = await fetch(`${issued.authUrl}/complete`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: "홍길동",
          birthdate: "19000208",
          gender: "1",
          national_info: "0",
          mobile_co: "2",
          mobile_no: "01012345678",
        }).toString(),
      });
      assert.equal(completeRes.status, 200);
      const html = await completeRes.text();
      assert.ok(html.includes(`action="${returnUrl}"`), "auto-submit form must target return_url");
      assert.ok(html.includes('name="web_transaction_id"'), "auto-submit form must carry hidden field");
      const match = /name="web_transaction_id" value="([^"]+)"/.exec(html);
      assert.ok(match !== null, "auto-submit HTML must embed web_transaction_id");
      const webTransactionId: string = match[1] ?? "";
      assert.ok(webTransactionId !== "");

      // Simulate the browser auto-submit: form POST to the catcher.
      const catcherRes = await fetch(returnUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ web_transaction_id: webTransactionId }).toString(),
      });
      assert.equal(catcherRes.status, 200);
      await catcherRes.text();
      const caught = await catcher.waitForRequest(WAIT_MS);
      assert.equal(caught.method, "POST");
      assert.equal(caught.query["requestNo"] ?? "", requestNo);
      const caughtBody = new URLSearchParams(caught.body);
      assert.equal(caughtBody.get("web_transaction_id"), webTransactionId);

      const result = await callResult(baseUrl, token.accessToken, requestNo, issued.transactionId, webTransactionId);
      assert.equal(result.status, 200);
      assert.equal(result.body["result_code"], "0000");
      const plaintext = decryptForTest(
        token.ticket,
        token.iterators,
        issued.transactionId,
        reqStr(result.body, "enc_data"),
        reqStr(result.body, "integrity_value"),
      );
      assertIdentityPayload(plaintext);
    } finally {
      await catcher.close();
      await app.close();
    }
  });

  it("failure flow: auto=1&fail=3032 -> result 3032; pending session also 3032", async () => {
    const { app, baseUrl } = await startApp();
    const catcher = await startReturnCatcher();
    try {
      const requestNoFail = newRequestNo("REQE2EFAIL");
      const returnUrlFail = `${catcher.baseUrl}/nice-id/return?requestNo=${requestNoFail}`;
      const tokenFail = await issueToken(baseUrl, requestNoFail);
      const issuedFail = await issueUrl(baseUrl, tokenFail.accessToken, requestNoFail, returnUrlFail, "GET");

      const failRes = await fetch(`${issuedFail.authUrl}?auto=1&fail=3032`);
      assert.equal(failRes.status, 200);
      const failHtml = await failRes.text();
      assert.ok(failHtml.includes("3032"), "failure page must show the injected code");

      const failResult = await callResult(
        baseUrl,
        tokenFail.accessToken,
        requestNoFail,
        issuedFail.transactionId,
        "never-issued-wtid",
      );
      assert.equal(failResult.status, 200);
      assert.equal(failResult.body["result_code"], "3032");

      const requestNoPending = newRequestNo("REQE2EPEND");
      const returnUrlPending = `${catcher.baseUrl}/nice-id/return?requestNo=${requestNoPending}`;
      const tokenPending = await issueToken(baseUrl, requestNoPending);
      const issuedPending = await issueUrl(baseUrl, tokenPending.accessToken, requestNoPending, returnUrlPending, "GET");
      const pendingResult = await callResult(
        baseUrl,
        tokenPending.accessToken,
        requestNoPending,
        issuedPending.transactionId,
        "pending-wtid-placeholder",
      );
      assert.equal(pendingResult.status, 200);
      assert.equal(pendingResult.body["result_code"], "3032");
    } finally {
      await catcher.close();
      await app.close();
    }
  });

  it("isolation: A completes while B is pending — no cross-contamination", async () => {
    const { app, baseUrl } = await startApp();
    const catcher = await startReturnCatcher();
    try {
      const requestNoA = newRequestNo("REQE2EISOA");
      const requestNoB = newRequestNo("REQE2EISOB");
      const returnUrlA = `${catcher.baseUrl}/nice-id/return?requestNo=${requestNoA}`;
      const returnUrlB = `${catcher.baseUrl}/nice-id/return?requestNo=${requestNoB}`;
      const tokenA = await issueToken(baseUrl, requestNoA);
      const issuedA = await issueUrl(baseUrl, tokenA.accessToken, requestNoA, returnUrlA, "GET");
      const tokenB = await issueToken(baseUrl, requestNoB);
      const issuedB = await issueUrl(baseUrl, tokenB.accessToken, requestNoB, returnUrlB, "GET");

      // A completes while B is still pending.
      const pageA = await fetch(`${issuedA.authUrl}?auto=1`, { redirect: "manual" });
      assert.equal(pageA.status, 302);
      const locationA = pageA.headers.get("location");
      await pageA.text();
      assert.ok(locationA !== null && locationA !== "");
      const webTransactionIdA = await followRedirectToCatcher(locationA, catcher);
      const caughtA = catcher.requests[catcher.requests.length - 1];
      assert.ok(caughtA !== undefined);
      assert.equal(caughtA.query["requestNo"] ?? "", requestNoA);

      // B must still be pending: 3032, untouched by A's completion.
      const pendingB = await callResult(
        baseUrl,
        tokenB.accessToken,
        requestNoB,
        issuedB.transactionId,
        "b-not-completed-yet",
      );
      assert.equal(pendingB.status, 200);
      assert.equal(pendingB.body["result_code"], "3032");

      // A's own result succeeds and decrypts.
      const resultA = await callResult(baseUrl, tokenA.accessToken, requestNoA, issuedA.transactionId, webTransactionIdA);
      assert.equal(resultA.status, 200);
      assert.equal(resultA.body["result_code"], "0000");
      const plaintextA = decryptForTest(
        tokenA.ticket,
        tokenA.iterators,
        issuedA.transactionId,
        reqStr(resultA.body, "enc_data"),
        reqStr(resultA.body, "integrity_value"),
      );
      assertIdentityPayload(plaintextA);

      // Cross-use: A's web_transaction_id against B's session must fail.
      const cross = await callResult(
        baseUrl,
        tokenB.accessToken,
        requestNoB,
        issuedB.transactionId,
        webTransactionIdA,
      );
      assert.equal(cross.status, 200);
      assert.equal(cross.body["result_code"], "3032");

      // B completes afterwards and gets its own success.
      const pageB = await fetch(`${issuedB.authUrl}?auto=1`, { redirect: "manual" });
      assert.equal(pageB.status, 302);
      const locationB = pageB.headers.get("location");
      await pageB.text();
      assert.ok(locationB !== null && locationB !== "");
      const webTransactionIdB = await followRedirectToCatcher(locationB, catcher);
      assert.ok(webTransactionIdB !== webTransactionIdA, "sessions must have distinct web_transaction_ids");
      const caughtB = catcher.requests[catcher.requests.length - 1];
      assert.ok(caughtB !== undefined);
      assert.equal(caughtB.query["requestNo"] ?? "", requestNoB);
      const resultB = await callResult(baseUrl, tokenB.accessToken, requestNoB, issuedB.transactionId, webTransactionIdB);
      assert.equal(resultB.status, 200);
      assert.equal(resultB.body["result_code"], "0000");
      const plaintextB = decryptForTest(
        tokenB.ticket,
        tokenB.iterators,
        issuedB.transactionId,
        reqStr(resultB.body, "enc_data"),
        reqStr(resultB.body, "integrity_value"),
      );
      assertIdentityPayload(plaintextB);
    } finally {
      await catcher.close();
      await app.close();
    }
  });
});
