import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearStore,
  createSession,
  isAuthWindowExpired,
  isTokenExpired,
  loadByAccessToken,
  loadByCertId,
  loadByRequestNo,
  purgeExpired,
  sessionsByAccessToken,
  sessionsByCertId,
  sessionsByRequestNo,
  startPurgeTimer,
  updateSession,
} from "../src/store.ts";
import { errorBody, ERROR_CODES } from "../src/errors.ts";

const REQUEST_NO = "REQ12345678901234567890";

function makeSession(now: number, tokenTtlMs = 86400000) {
  return createSession(REQUEST_NO, { now, tokenTtlMs, iterators: 66 });
}

describe("session store", () => {
  beforeEach(() => {
    clearStore();
  });

  it("creates a session on three indexes with ticket and JWT-shaped token", () => {
    const now = 1700000000000;
    const session = makeSession(now);
    assert.equal(session.requestNo, REQUEST_NO);
    assert.match(session.ticket, /^[A-Za-z0-9_-]{56}$/);
    assert.equal(session.tokenExpiresAt, now + 86400000);
    assert.equal(session.status, "CREATED");

    const parts = session.accessToken.split(".");
    assert.equal(parts.length, 3);
    for (const part of parts) {
      assert.match(part ?? "", /^[A-Za-z0-9_-]+$/);
    }
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(payload["tid"], REQUEST_NO);
    assert.deepEqual(payload["scope"], ["M", "F", "U", "C", "I"]);
    assert.equal(payload["iat"], now);
    assert.equal(payload["exp"], now + 86400000);

    assert.ok(sessionsByRequestNo.has(REQUEST_NO));
    assert.equal(sessionsByAccessToken.get(session.accessToken), REQUEST_NO);
    assert.deepEqual(loadByRequestNo(REQUEST_NO)?.accessToken, session.accessToken);
    assert.deepEqual(loadByAccessToken(session.accessToken)?.requestNo, REQUEST_NO);
  });

  it("token expiry boundary: now >= tokenExpiresAt counts expired", () => {
    const now = 1700000000000;
    const session = makeSession(now, 1000);
    assert.equal(isTokenExpired(session, now + 999), false);
    assert.equal(isTokenExpired(session, now + 1000), true);
    assert.equal(isTokenExpired(session, now + 1001), true);
  });

  it("keeps expired sessions until the sweep so unknown stays distinct from expired", () => {
    const now = 1700000000000;
    const session = makeSession(now, 1000);
    // Still loadable after expiry (routes decide 1003 vs 1004).
    assert.ok(loadByRequestNo(REQUEST_NO) !== undefined);
    assert.ok(loadByAccessToken(session.accessToken) !== undefined);
    assert.equal(loadByRequestNo("NO-SUCH-REQUEST") , undefined);
    // errorBody mapping used by those routes:
    assert.equal(errorBody("1004").result_code, "1004");
    assert.equal(errorBody("1003").result_code, "1003");
  });

  it("10-min auth window flag uses strict greater-than", () => {
    const now = 1700000000000;
    makeSession(now);
    updateSession(REQUEST_NO, { authUrlExpiresAt: now + 600000, status: "PENDING" });
    const loaded = loadByRequestNo(REQUEST_NO);
    assert.ok(loaded !== undefined);
    assert.equal(isAuthWindowExpired(loaded, now + 599999), false);
    assert.equal(isAuthWindowExpired(loaded, now + 600000), false);
    assert.equal(isAuthWindowExpired(loaded, now + 600001), true);
  });

  it("isAuthWindowExpired is false when no auth URL was issued", () => {
    const session = makeSession(1700000000000);
    assert.equal(isAuthWindowExpired(session), false);
  });

  it("purgeExpired removes only token-expired sessions, never auth-window-expired ones", () => {
    const now = 1700000000000;
    const expired = createSession("REQ-EXPIRED-00000000001", { now, tokenTtlMs: 1000 });
    const windowExpired = createSession("REQ-WINDOW-000000000001", { now, tokenTtlMs: 86400000 });
    updateSession("REQ-WINDOW-000000000001", {
      certId: "S-window-cert",
      authUrlExpiresAt: now - 1,
      status: "PENDING",
    });

    const purged = purgeExpired(now + 1001);
    assert.equal(purged, 1);
    assert.equal(loadByRequestNo("REQ-EXPIRED-00000000001"), undefined);
    assert.equal(loadByAccessToken(expired.accessToken), undefined);
    // Auth-window-expired session survives for downstream 3032.
    assert.ok(loadByRequestNo("REQ-WINDOW-000000000001") !== undefined);
    assert.ok(loadByCertId("S-window-cert") !== undefined);
    assert.equal(isAuthWindowExpired(windowExpired, now + 1001), false);
    const reloaded = loadByRequestNo("REQ-WINDOW-000000000001");
    assert.ok(reloaded !== undefined);
    assert.equal(isAuthWindowExpired(reloaded, now + 1001), true);
  });

  it("rotation via createSession invalidates the stale token index entry", () => {
    const first = makeSession(1700000000000);
    const second = createSession(REQUEST_NO, { now: 1700000001000 });
    assert.notEqual(first.accessToken, second.accessToken);
    assert.notEqual(first.ticket, second.ticket);
    assert.equal(loadByAccessToken(first.accessToken), undefined);
    assert.deepEqual(loadByAccessToken(second.accessToken)?.requestNo, REQUEST_NO);
  });

  it("updateSession moves certId and accessToken indexes, dropping stale entries", () => {
    const session = makeSession(1700000000000);
    updateSession(REQUEST_NO, { certId: "S-cert-one", transactionId: "tx-one" });
    assert.deepEqual(loadByCertId("S-cert-one")?.requestNo, REQUEST_NO);

    updateSession(REQUEST_NO, { certId: "S-cert-two", transactionId: "tx-two" });
    assert.equal(loadByCertId("S-cert-one"), undefined);
    assert.deepEqual(loadByCertId("S-cert-two")?.requestNo, REQUEST_NO);

    updateSession(REQUEST_NO, { accessToken: "rotated.token.value" });
    assert.equal(loadByAccessToken(session.accessToken), undefined);
    assert.deepEqual(loadByAccessToken("rotated.token.value")?.requestNo, REQUEST_NO);
  });

  it("updateSession on unknown requestNo returns undefined", () => {
    assert.equal(updateSession("NO-SUCH-REQUEST", { status: "SUCCESS" }), undefined);
  });

  it("certId lookup misses return undefined", () => {
    assert.equal(loadByCertId("S-missing"), undefined);
  });

  it("purge timer is unrefed so tests exit", () => {
    const timer = startPurgeTimer(60_000);
    assert.equal(timer.hasRef(), false);
    clearInterval(timer);
  });

  it("error table holds exactly the 12 documented codes", () => {
    assert.deepEqual([...ERROR_CODES], [
      "1001",
      "1002",
      "1003",
      "1004",
      "1006",
      "1014",
      "2001",
      "3001",
      "3011",
      "3029",
      "3032",
      "3033",
    ]);
  });
});
