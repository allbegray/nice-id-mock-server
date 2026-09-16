import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildApp } from "../src/app.ts";
import { decryptForTest } from "../src/crypto.ts";
import {
  deriveCi,
  deriveDi,
  GENDER_CODES,
  MOBILE_CO_CODES,
  NATIONAL_CODES,
  PRESET_ADULT_MALE,
  RESULT_JSON_KEYS,
} from "../src/identity.ts";
import { createSession, loadByRequestNo, updateSession } from "../src/store.ts";
import type { SessionStatus } from "../src/types.ts";
import { closeTestDb, initTestDb } from "./helpers/testDb.ts";

const PATH = "/ido/intc/v1.0/auth/result";
const REQUEST_NO = "REQ12345678901234567890";
const UNKNOWN_REQUEST_NO = "REQ00000000000000000000";

function base64urlBytes(n: number): string {
  return randomBytes(n).toString("base64url");
}

interface Seeded {
  accessToken: string;
  ticket: string;
  iterators: number;
  transactionId: string;
  webTransactionId: string;
}

function seedSession(
  requestNo: string,
  overrides: {
    status?: SessionStatus;
    failCode?: string;
    authUrlExpiresAt?: number;
    webTransactionId?: string;
    tokenTtlMs?: number;
  } = {},
): Seeded {
  const created = createSession(requestNo, { tokenTtlMs: overrides.tokenTtlMs });
  const transactionId = base64urlBytes(42);
  const webTransactionId = overrides.webTransactionId ?? base64urlBytes(24);
  const updated = updateSession(requestNo, {
    transactionId,
    authUrlExpiresAt: overrides.authUrlExpiresAt ?? Date.now() + 600000,
    status: overrides.status ?? "SUCCESS",
    identity: { ...PRESET_ADULT_MALE },
    webTransactionId,
    ...(overrides.failCode !== undefined ? { failCode: overrides.failCode } : {}),
  });
  assert.ok(updated !== undefined);
  return {
    accessToken: created.accessToken,
    ticket: updated.ticket,
    iterators: updated.iterators,
    transactionId,
    webTransactionId,
  };
}

function validBody(seed: Seeded, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    web_transaction_id: seed.webTransactionId,
    transaction_id: seed.transactionId,
    request_no: REQUEST_NO,
    ...overrides,
  };
}

describe("POST /ido/intc/v1.0/auth/result", () => {
  let savedStrict: string | undefined;
  let strictWasSet: boolean;

  beforeEach(() => {
    initTestDb();
    savedStrict = process.env["STRICT_ONE_TIME_RESULT"];
    strictWasSet = Object.hasOwn(process.env, "STRICT_ONE_TIME_RESULT");
    delete process.env["STRICT_ONE_TIME_RESULT"];
  });

  afterEach(() => {
    if (strictWasSet) {
      process.env["STRICT_ONE_TIME_RESULT"] = savedStrict ?? "";
    } else {
      delete process.env["STRICT_ONE_TIME_RESULT"];
    }
    closeTestDb();
  });

  it("happy path: 0000 with exact 4 fields, decryptable enc_data, resultFetchedAt set", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed),
      });

      assert.equal(response.statusCode, 200);
      const body = response.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), [
        "enc_data",
        "integrity_value",
        "result_code",
        "result_message",
      ]);
      assert.equal(body["result_code"], "0000");
      assert.equal(body["result_message"], "응답성공");

      const stored = loadByRequestNo(REQUEST_NO);
      assert.ok(stored !== undefined);
      assert.ok(stored.resultFetchedAt !== undefined);

      const plaintext = decryptForTest(
        seed.ticket,
        seed.iterators,
        seed.transactionId,
        body["enc_data"] as string,
        body["integrity_value"] as string,
      );
      const parsed = JSON.parse(plaintext) as Record<string, unknown>;
      assert.deepEqual([...Object.keys(parsed)].sort(), [...RESULT_JSON_KEYS].sort());
      assert.equal(parsed["name"], "홍길동");
      assert.equal(parsed["mobile_no"], "01012345678");
      assert.equal((parsed["ci"] as string).length, 86);
      assert.equal((parsed["di"] as string).length, 86);
      assert.equal(parsed["ci"], deriveCi(PRESET_ADULT_MALE));
      assert.equal(parsed["di"], deriveDi(PRESET_ADULT_MALE, "test-client-id"));
      assert.ok(GENDER_CODES.includes(parsed["gender"] as string));
      assert.ok(NATIONAL_CODES.includes(parsed["national_info"] as string));
      assert.ok(MOBILE_CO_CODES.includes(parsed["mobile_co"] as string));
    } finally {
      await app.close();
    }
  });

  it("accepts extra body fields", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed, { extra_field: "ignored", svc_types: ["M"] }),
      });
      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "0000");
    } finally {
      await app.close();
    }
  });

  it("not-completed sessions (CREATED/PENDING/CANCELLED) -> 200/3032", async () => {
    const app = buildApp();
    try {
      const statuses: SessionStatus[] = ["CREATED", "PENDING", "CANCELLED"];
      for (const status of statuses) {
        const requestNo = `REQ${status}123456789012345`;
        assert.ok(requestNo.length >= 20 && requestNo.length <= 50);
        const seed = seedSession(requestNo, { status });
        const response = await app.inject({
          method: "POST",
          url: PATH,
          headers: { authorization: `Bearer ${seed.accessToken}` },
          payload: {
            web_transaction_id: seed.webTransactionId,
            transaction_id: seed.transactionId,
            request_no: requestNo,
          },
        });
        assert.equal(response.statusCode, 200, `status=${status}`);
        assert.deepEqual(
          response.json(),
          {
            result_code: "3032",
            result_message: "인증 성공건이 아니거나 유효시간 초과",
          },
          `status=${status}`,
        );
      }
    } finally {
      await app.close();
    }
  });

  it("wrong transaction_id -> 200/3029", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed, { transaction_id: base64urlBytes(42) }),
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        result_code: "3029",
        result_message: "요청한 정보를 찾을 수 없음",
      });
    } finally {
      await app.close();
    }
  });

  it("unknown well-formed request_no -> 200/3029", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: {
          web_transaction_id: seed.webTransactionId,
          transaction_id: seed.transactionId,
          request_no: UNKNOWN_REQUEST_NO,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        result_code: "3029",
        result_message: "요청한 정보를 찾을 수 없음",
      });
    } finally {
      await app.close();
    }
  });

  it("malformed request_no -> 400/1002 (precedence before session lookup)", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      for (const bad of ["short", "", "x".repeat(51)]) {
        const response = await app.inject({
          method: "POST",
          url: PATH,
          headers: { authorization: `Bearer ${seed.accessToken}` },
          payload: validBody(seed, { request_no: bad }),
        });
        assert.equal(response.statusCode, 400, `request_no=${JSON.stringify(bad)}`);
        assert.deepEqual(response.json(), {
          result_code: "1002",
          result_message: "파라미터 유효성 오류",
        });
      }
    } finally {
      await app.close();
    }
  });

  it("expired auth window -> 200/3032", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO, { authUrlExpiresAt: Date.now() - 1000 });
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed),
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        result_code: "3032",
        result_message: "인증 성공건이 아니거나 유효시간 초과",
      });
    } finally {
      await app.close();
    }
  });

  it("web_transaction_id mismatch on SUCCESS -> 200/3032", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed, { web_transaction_id: "wrong-web-transaction-id-1" }),
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        result_code: "3032",
        result_message: "인증 성공건이 아니거나 유효시간 초과",
      });
    } finally {
      await app.close();
    }
  });

  it("FAILED session returns injected fail code (default 3032)", async () => {
    const app = buildApp();
    try {
      const seedDefault = seedSession(REQUEST_NO, { status: "FAILED" });
      const resDefault = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seedDefault.accessToken}` },
        payload: validBody(seedDefault),
      });
      assert.equal(resDefault.statusCode, 200);
      assert.deepEqual(resDefault.json(), {
        result_code: "3032",
        result_message: "인증 성공건이 아니거나 유효시간 초과",
      });

      const otherNo = "REQFAILEDINJECT1234567890";
      const seedInjected = seedSession(otherNo, { status: "FAILED", failCode: "3029" });
      const resInjected = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seedInjected.accessToken}` },
        payload: {
          web_transaction_id: seedInjected.webTransactionId,
          transaction_id: seedInjected.transactionId,
          request_no: otherNo,
        },
      });
      assert.equal(resInjected.statusCode, 200);
      assert.deepEqual(resInjected.json(), {
        result_code: "3029",
        result_message: "요청한 정보를 찾을 수 없음",
      });
    } finally {
      await app.close();
    }
  });

  it("STRICT_ONE_TIME_RESULT: HTTP-level double POST -> second is 200/3033", async () => {
    process.env["STRICT_ONE_TIME_RESULT"] = "true";
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const first = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed),
      });
      assert.equal(first.statusCode, 200);
      assert.equal((first.json() as Record<string, unknown>)["result_code"], "0000");

      const second = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed),
      });
      assert.equal(second.statusCode, 200);
      assert.deepEqual(second.json(), {
        result_code: "3033",
        result_message: "기 인증결과 제공 건",
      });
    } finally {
      await app.close();
    }
  });

  it("non-strict mode: repeat fetch still succeeds", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      for (let i = 0; i < 2; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: PATH,
          headers: { authorization: `Bearer ${seed.accessToken}` },
          payload: validBody(seed),
        });
        assert.equal(response.statusCode, 200, `attempt=${i}`);
        assert.equal((response.json() as Record<string, unknown>)["result_code"], "0000");
      }
    } finally {
      await app.close();
    }
  });

  it("missing bearer -> 400/1004", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        payload: validBody(seed),
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

  it("unknown bearer -> 400/1004", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: "Bearer not-a-real-token" },
        payload: validBody(seed),
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

  it("expired bearer -> 400/1003", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO, { tokenTtlMs: 0 });
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seed.accessToken}` },
        payload: validBody(seed),
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

  it("garbage JSON body -> 200/3001", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: `Bearer ${seed.accessToken}`,
          "content-type": "application/json",
        },
        payload: "not-json{{{",
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        result_code: "3001",
        result_message: "JSON 형식의 메시지가 아님",
      });
    } finally {
      await app.close();
    }
  });

  it("text/plain garbage body -> 200/3001", async () => {
    const app = buildApp();
    try {
      const seed = seedSession(REQUEST_NO);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          authorization: `Bearer ${seed.accessToken}`,
          "content-type": "text/plain",
        },
        payload: "garbage",
      });
      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "3001");
    } finally {
      await app.close();
    }
  });

  it("distinct sessions do not cross-contaminate", async () => {
    const app = buildApp();
    try {
      const requestNoA = `REQA-${randomUUID()}`;
      const requestNoB = `REQB-${randomUUID()}`;
      const seedA = seedSession(requestNoA);
      const seedB = seedSession(requestNoB);
      const response = await app.inject({
        method: "POST",
        url: PATH,
        headers: { authorization: `Bearer ${seedA.accessToken}` },
        payload: {
          web_transaction_id: seedB.webTransactionId,
          transaction_id: seedB.transactionId,
          request_no: requestNoA,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as Record<string, unknown>)["result_code"], "3029");
    } finally {
      await app.close();
    }
  });

  it("DI is client-scoped: same identity under client-a vs client-b -> CI equal, DI different", async () => {
    const savedStrictCreds = process.env["STRICT_CREDENTIALS"];
    const strictCredsWasSet = Object.hasOwn(process.env, "STRICT_CREDENTIALS");
    process.env["STRICT_CREDENTIALS"] = "true";
    const app = buildApp();
    try {
      const requestNoA = "REQ-CLIENT-A-0123456789";
      const requestNoB = "REQ-CLIENT-B-0123456789";
      assert.ok(requestNoA.length >= 20 && requestNoA.length <= 50);
      assert.ok(requestNoB.length >= 20 && requestNoB.length <= 50);
      const createdA = createSession(requestNoA, { clientId: "client-a" });
      const createdB = createSession(requestNoB, { clientId: "client-b" });
      const transactionIdA = base64urlBytes(42);
      const transactionIdB = base64urlBytes(42);
      const webTransactionIdA = base64urlBytes(24);
      const webTransactionIdB = base64urlBytes(24);
      const updatedA = updateSession(requestNoA, {
        transactionId: transactionIdA,
        webTransactionId: webTransactionIdA,
        status: "SUCCESS",
        identity: { ...PRESET_ADULT_MALE },
      });
      const updatedB = updateSession(requestNoB, {
        transactionId: transactionIdB,
        webTransactionId: webTransactionIdB,
        status: "SUCCESS",
        identity: { ...PRESET_ADULT_MALE },
      });
      assert.ok(updatedA !== undefined);
      assert.ok(updatedB !== undefined);

      async function fetchDecrypted(
        accessToken: string,
        requestNo: string,
        transactionId: string,
        webTransactionId: string,
        ticket: string,
        iterators: number,
      ): Promise<Record<string, unknown>> {
        const response = await app.inject({
          method: "POST",
          url: PATH,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: {
            request_no: requestNo,
            transaction_id: transactionId,
            web_transaction_id: webTransactionId,
          },
        });
        assert.equal(response.statusCode, 200, `request_no=${requestNo}`);
        const body = response.json() as Record<string, unknown>;
        assert.equal(body["result_code"], "0000", `request_no=${requestNo}`);
        const plaintext = decryptForTest(
          ticket,
          iterators,
          transactionId,
          body["enc_data"] as string,
          body["integrity_value"] as string,
        );
        return JSON.parse(plaintext) as Record<string, unknown>;
      }

      const parsedA = await fetchDecrypted(
        createdA.accessToken,
        requestNoA,
        transactionIdA,
        webTransactionIdA,
        updatedA.ticket,
        updatedA.iterators,
      );
      const parsedB = await fetchDecrypted(
        createdB.accessToken,
        requestNoB,
        transactionIdB,
        webTransactionIdB,
        updatedB.ticket,
        updatedB.iterators,
      );

      assert.equal(parsedA["ci"], deriveCi(PRESET_ADULT_MALE));
      assert.equal(parsedB["ci"], deriveCi(PRESET_ADULT_MALE));
      assert.equal(parsedA["di"], deriveDi(PRESET_ADULT_MALE, "client-a"));
      assert.equal(parsedB["di"], deriveDi(PRESET_ADULT_MALE, "client-b"));
      assert.equal(parsedA["ci"], parsedB["ci"]);
      assert.notEqual(parsedA["di"], parsedB["di"]);
    } finally {
      if (strictCredsWasSet) {
        process.env["STRICT_CREDENTIALS"] = savedStrictCreds ?? "";
      } else {
        delete process.env["STRICT_CREDENTIALS"];
      }
      await app.close();
    }
  });
});
