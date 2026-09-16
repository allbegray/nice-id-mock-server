// Live admin-CRUD + restart-persistence proof, phase 1 of 2 (pre-restart).
//
// Usage: node tools/e2e-admin-persistence.mjs --phase 1|2  (exactly one arg)
//
// Phase 1: smoke client full CRUD lifecycle (create -> list masked ->
// rotate -> old 1006 / rotated 0000 -> delete -> rotated 1006 proves the
// delete), then creates the persist client, issues one fixed-request_no
// token, and writes /tmp/v2-persist-state.json for phase 2.
// Phase 2 (after `docker compose down && docker compose up -d`): loads the
// state file, asserts the client survived, proves the stored Bearer still
// resolves through /auth/url, then cleans up.
//
// Secrets and request_no values are pinned literals shared by both phases.
// Tokens are NEVER printed raw: mask() shows the first 8 chars + "...".
// Every fetch carries a 10s timeout; every failure prints `FAIL: <step>`
// and exits 1.
//
// No dependencies beyond Node builtins (fetch, fs).

import { readFileSync, rmSync, writeFileSync } from "node:fs";

const MOCK_BASE_URL = process.env["MOCK_BASE_URL"] ?? "http://localhost:8899";
const FETCH_TIMEOUT_MS = 10000;
const TTL_MARGIN_MS = 60000;
const STATE_PATH = "/tmp/v2-persist-state.json";

// Pinned literals (shared by phase 1 and phase 2):
const SMOKE_ID = "v2-smoke-client";
const SMOKE_SECRET = "v2-smoke-secret";
const SMOKE_ROTATED_SECRET = "v2-smoke-rotated-secret";
const PERSIST_ID = "v2-persist-client";
const PERSIST_SECRET = "v2-persist-secret";
// request_no literals: both must be 20-50 chars (server rejects otherwise).
const SMOKE_REQ = "REQV2SMOKEFIXED0000000001"; // length 24 (20-50 OK)
const PERSIST_REQ = "REQV2PERSISTFIXED00000001"; // length 24 (20-50 OK)

function fail(step, detail) {
  const suffix = detail === undefined ? "" : `: ${detail}`;
  console.error(`FAIL: ${step}${suffix}`);
  process.exit(1);
}

function ok(message) {
  console.log(`e2e-admin-persistence: ${message}`);
}

// Tokens are never printed raw: first 8 chars + "..." only.
function mask(token) {
  if (typeof token !== "string" || token.length === 0) {
    return "<empty>";
  }
  return `${token.slice(0, 8)}...`;
}

function parsePhase(argv) {
  if (argv.length !== 2 || argv[0] !== "--phase" || (argv[1] !== "1" && argv[1] !== "2")) {
    fail("usage", "expected exactly: node tools/e2e-admin-persistence.mjs --phase 1|2");
  }
  return argv[1];
}

async function fetchRaw(url, init, step) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    fail(step, `fetch to ${url} threw: ${err?.message ?? err}`);
  }
  let body;
  if (res.status === 204) {
    body = undefined;
  } else {
    const text = await res
      .text()
      .catch((err) => fail(step, `read body failed: ${err?.message ?? err}`));
    if (text === "") {
      body = undefined;
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        fail(step, `expected JSON from ${url} (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
    }
  }
  return { status: res.status, body };
}

function basicAuth(clientId, clientSecret) {
  // Server round-trips base64url-no-pad (authToken.ts): standard base64
  // padding ("=") or "+/" chars are rejected with 1001.
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64url")}`;
}

async function adminDelete(clientId, step) {
  return fetchRaw(
    `${MOCK_BASE_URL}/admin/clients/${encodeURIComponent(clientId)}`,
    { method: "DELETE" },
    step,
  );
}

async function adminCreate(clientId, clientSecret, step) {
  return fetchRaw(
    `${MOCK_BASE_URL}/admin/clients`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    },
    step,
  );
}

async function adminSetSecret(clientId, clientSecret, step) {
  return fetchRaw(
    `${MOCK_BASE_URL}/admin/clients/${encodeURIComponent(clientId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSecret }),
    },
    step,
  );
}

async function adminList(step) {
  const { status, body } = await fetchRaw(`${MOCK_BASE_URL}/admin/clients`, {}, step);
  if (status !== 200) {
    fail(step, `expected HTTP 200, got ${status}: ${JSON.stringify(body)}`);
  }
  if (body === undefined || !Array.isArray(body.clients)) {
    fail(step, `expected {clients: []}, got ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return body.clients;
}

// Normalize to a known secret: POST, and on 409 PUT the pinned secret.
async function ensureClient(clientId, secret, step) {
  const created = await adminCreate(clientId, secret, step);
  if (created.status === 201) {
    ok(`${step}: created ${clientId} (201)`);
    return;
  }
  if (created.status === 409) {
    const updated = await adminSetSecret(clientId, secret, step);
    if (updated.status !== 200) {
      fail(
        step,
        `409-normalize PUT expected HTTP 200, got ${updated.status}: ${JSON.stringify(updated.body)}`,
      );
    }
    ok(`${step}: ${clientId} existed (409), normalized secret via PUT (200)`);
    return;
  }
  fail(
    step,
    `POST expected HTTP 201 or 409, got ${created.status}: ${JSON.stringify(created.body)}`,
  );
}

async function issueToken(clientId, secret, requestNo, step) {
  return fetchRaw(
    `${MOCK_BASE_URL}/ido/intc/v1.0/auth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basicAuth(clientId, secret) },
      body: JSON.stringify({ grant_type: "client_credentials", request_no: requestNo }),
    },
    step,
  );
}

function expectTokenCode(call, httpStatus, resultCode, step) {
  if (call.status !== httpStatus) {
    fail(step, `expected HTTP ${httpStatus}, got ${call.status}: ${JSON.stringify(call.body)}`);
  }
  if (call.body?.result_code !== resultCode) {
    fail(step, `expected result_code ${resultCode}, got ${JSON.stringify(call.body)}`);
  }
}

async function issueAuthUrl(accessToken, requestNo, returnUrl, step) {
  const call = await fetchRaw(
    `${MOCK_BASE_URL}/ido/intc/v1.0/auth/url`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        request_no: requestNo,
        return_url: returnUrl,
        svc_types: ["M"],
        method_type: "GET",
      }),
    },
    step,
  );
  if (call.status !== 200) {
    fail(step, `expected HTTP 200, got ${call.status}: ${JSON.stringify(call.body)}`);
  }
  if (call.body?.result_code !== "0000") {
    fail(step, `expected result_code 0000, got ${JSON.stringify(call.body)}`);
  }
  if (typeof call.body?.auth_url !== "string" || typeof call.body?.transaction_id !== "string") {
    fail(
      step,
      `expected auth_url/transaction_id strings, got ${JSON.stringify(call.body)?.slice(0, 200)}`,
    );
  }
  return call.body;
}

async function phase1() {
  // Stale-file guard FIRST: a leftover state file from an interrupted run
  // must never be misread by phase 2.
  try {
    rmSync(STATE_PATH, { force: true });
  } catch (err) {
    fail("phase1-stale-state-guard", `rm -f ${STATE_PATH} threw: ${err?.message ?? err}`);
  }
  ok("phase1: stale state file removed");

  // (a) Smoke: full CRUD lifecycle on the throwaway client.
  const deleted = await adminDelete(SMOKE_ID, "phase1-smoke-cleanup");
  if (deleted.status !== 204 && deleted.status !== 404) {
    fail(
      "phase1-smoke-cleanup",
      `DELETE expected 204 or 404, got ${deleted.status}: ${JSON.stringify(deleted.body)}`,
    );
  }
  ok(`phase1: smoke pre-delete ${deleted.status} (204 fresh / 404 ignored)`);

  await ensureClient(SMOKE_ID, SMOKE_SECRET, "phase1-smoke-create");

  const clients = await adminList("phase1-smoke-list");
  const smokeEntry = clients.find((entry) => entry?.clientId === SMOKE_ID);
  if (smokeEntry === undefined) {
    fail("phase1-smoke-list", `list missing ${SMOKE_ID}`);
  }
  if (typeof smokeEntry.clientSecretMasked !== "string" || smokeEntry.clientSecretMasked === "") {
    fail(
      "phase1-smoke-list",
      `expected masked secret string, got ${JSON.stringify(smokeEntry)?.slice(0, 200)}`,
    );
  }
  if (
    smokeEntry.clientSecretMasked === SMOKE_SECRET ||
    smokeEntry.clientSecretMasked.includes(SMOKE_SECRET)
  ) {
    fail("phase1-smoke-list", "list leaked the raw secret (expected masked)");
  }
  ok(`phase1: list shows ${SMOKE_ID} masked as ${smokeEntry.clientSecretMasked}`);

  const rotated = await adminSetSecret(SMOKE_ID, SMOKE_ROTATED_SECRET, "phase1-smoke-rotate");
  if (rotated.status !== 200) {
    fail(
      "phase1-smoke-rotate",
      `PUT expected HTTP 200, got ${rotated.status}: ${JSON.stringify(rotated.body)}`,
    );
  }
  ok(`phase1: rotated ${SMOKE_ID} secret via PUT (200)`);

  expectTokenCode(
    await issueToken(SMOKE_ID, SMOKE_SECRET, SMOKE_REQ, "phase1-smoke-old-secret"),
    400,
    "1006",
    "phase1-smoke-old-secret",
  );
  ok("phase1: old secret rejected with 1006");

  const rotatedCall = await issueToken(
    SMOKE_ID,
    SMOKE_ROTATED_SECRET,
    SMOKE_REQ,
    "phase1-smoke-rotated-secret",
  );
  expectTokenCode(rotatedCall, 200, "0000", "phase1-smoke-rotated-secret");
  ok(`phase1: rotated secret accepted (0000, token=${mask(rotatedCall.body.access_token)})`);

  const removed = await adminDelete(SMOKE_ID, "phase1-smoke-delete");
  if (removed.status !== 204) {
    fail(
      "phase1-smoke-delete",
      `DELETE expected HTTP 204, got ${removed.status}: ${JSON.stringify(removed.body)}`,
    );
  }
  ok(`phase1: deleted ${SMOKE_ID} (204)`);

  // Prove the delete with the ROTATED secret: testing with the stale (old)
  // secret would return 1006 vacuously even if the client still existed.
  expectTokenCode(
    await issueToken(SMOKE_ID, SMOKE_ROTATED_SECRET, SMOKE_REQ, "phase1-smoke-deleted"),
    400,
    "1006",
    "phase1-smoke-deleted",
  );
  ok("phase1: rotated secret now 1006 (deletion proven, not vacuous)");
  console.log("e2e-admin-persistence: phase 1 smoke CRUD PASS");

  // (b) Persist prep: the client + token that must survive the restart.
  const persistDeleted = await adminDelete(PERSIST_ID, "phase1-persist-cleanup");
  if (persistDeleted.status !== 204 && persistDeleted.status !== 404) {
    fail(
      "phase1-persist-cleanup",
      `DELETE expected 204 or 404, got ${persistDeleted.status}: ${JSON.stringify(persistDeleted.body)}`,
    );
  }
  await ensureClient(PERSIST_ID, PERSIST_SECRET, "phase1-persist-create");

  const tokenCall = await issueToken(
    PERSIST_ID,
    PERSIST_SECRET,
    PERSIST_REQ,
    "phase1-persist-token",
  );
  expectTokenCode(tokenCall, 200, "0000", "phase1-persist-token");
  const accessToken = tokenCall.body?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    fail("phase1-persist-token", "expected non-empty access_token string");
  }
  // expires_in carries the absolute token-expiry epoch (ms); reuse it as-is.
  const tokenExpiresAt = tokenCall.body?.expires_in;
  if (typeof tokenExpiresAt !== "number" || !Number.isFinite(tokenExpiresAt)) {
    fail(
      "phase1-persist-token",
      `expected numeric expires_in, got ${JSON.stringify(tokenExpiresAt)}`,
    );
  }
  ok(
    `phase1: persist token issued (0000, token=${mask(accessToken)}, expiresAt=${tokenExpiresAt})`,
  );

  const urlBody = await issueAuthUrl(
    accessToken,
    PERSIST_REQ,
    `http://localhost:8080/nice-id/return?requestNo=${PERSIST_REQ}`,
    "phase1-persist-auth-url",
  );
  ok(
    `phase1: persist auth_url issued (transaction_id=${String(urlBody.transaction_id).slice(0, 8)}...)`,
  );

  const state = {
    accessToken,
    requestNo: PERSIST_REQ,
    transactionId: urlBody.transaction_id,
    tokenExpiresAt,
  };
  try {
    writeFileSync(STATE_PATH, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch (err) {
    fail("phase1-persist-state-write", `write ${STATE_PATH} threw: ${err?.message ?? err}`);
  }
  ok(`phase1: state written to ${STATE_PATH} (token masked: ${mask(accessToken)})`);
  console.log("e2e-admin-persistence: phase 1 PASS");
}

async function phase2() {
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    fail("phase2-state-missing", `${STATE_PATH} missing or unparseable (was phase 1 run?)`);
  }
  const { accessToken, requestNo, tokenExpiresAt } = state;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof requestNo !== "string" ||
    typeof tokenExpiresAt !== "number"
  ) {
    fail(
      "phase2-state-missing",
      `state file has wrong shape: ${JSON.stringify(Object.keys(state ?? {}))}`,
    );
  }

  // TTL margin FIRST: if this trips, check TOKEN_TTL_MS and the compose
  // restart duration — it is an environment/timing issue, not a product bug.
  if (!(Date.now() < tokenExpiresAt - TTL_MARGIN_MS)) {
    fail(
      "phase2-token-ttl-margin",
      `token too close to expiry (now=${Date.now()}, expiresAt=${tokenExpiresAt}, margin=${TTL_MARGIN_MS}ms). ` +
        `Check TOKEN_TTL_MS and the compose down/up duration; not a product bug.`,
    );
  }
  ok(`phase2: TTL margin ok (token=${mask(accessToken)}, expiresAt=${tokenExpiresAt})`);

  // (a) The persist client survived the compose down/up.
  const clients = await adminList("phase2-client-survived");
  if (!clients.some((entry) => entry?.clientId === PERSIST_ID)) {
    fail(
      "phase2-client-survived",
      `list missing ${PERSIST_ID} after restart (is the ./data bind mount intact?)`,
    );
  }
  ok(`phase2: ${PERSIST_ID} present in client list after restart`);

  // (b) The stored Bearer still resolves through /auth/url (fresh return_url).
  const urlBody = await issueAuthUrl(
    accessToken,
    requestNo,
    `http://localhost:8080/nice-id/return/phase2?requestNo=${requestNo}`,
    "phase2-auth-url-after-restart",
  );
  ok(
    `phase2: stored Bearer valid after restart (0000, transaction_id=${String(urlBody.transaction_id).slice(0, 8)}...)`,
  );

  // (c) Cleanup: delete the persist client, then remove the state file.
  const removed = await adminDelete(PERSIST_ID, "phase2-cleanup-delete");
  if (removed.status !== 204) {
    fail(
      "phase2-cleanup-delete",
      `DELETE expected HTTP 204, got ${removed.status}: ${JSON.stringify(removed.body)}`,
    );
  }
  ok(`phase2: deleted ${PERSIST_ID} (204)`);
  try {
    rmSync(STATE_PATH, { force: true });
  } catch (err) {
    fail("phase2-cleanup-state", `rm -f ${STATE_PATH} threw: ${err?.message ?? err}`);
  }
  ok("phase2: state file removed");
  console.log("e2e-admin-persistence: phase 2 PASS");
}

const phase = parsePhase(process.argv.slice(2));
if (phase === "1") {
  await phase1();
} else {
  await phase2();
}
