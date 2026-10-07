import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./db.ts";
import type { AuthMethod, Identity, Session, SessionStatus } from "./types.ts";

// SQLite-backed session store for the NICE mock server.
//
// Export names and signatures match the original in-memory store:
// - Three loaders (by request_no / cert_id / access_token) replace the
//   three Map indexes. Rotation (re-create under the same request_no)
//   deletes the old row, so stale tokens/certIds resolve to unknown.
// - Expiry model (mirrors Token.kt `now >= expiresIn`):
//   - Token expiry boundary: `now >= tokenExpiresAt` counts as expired.
//   - Auth-window expiry boundary: `now > authUrlExpiresAt` (strict).
//   - Reads never purge. purgeExpired() removes ONLY token-expired
//     sessions — NEVER auth-window-expired ones, because routes must still
//     return 3032 (not 3029) for those.
// - `client_id` is readable, immutable audit data: it is stored per row at
//   creation and mapped onto Session.clientId on every load; updateSession
//   can never change it (no columnFor entry by design).

export const DEFAULT_TOKEN_TTL_MS = 86400000;

export interface CreateSessionOptions {
  tokenTtlMs?: number;
  iterators?: number;
  clientId?: string;
  now?: number;
}

const TOKEN_SCOPE = ["M", "F", "U", "C", "I"] as const;

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function buildAccessToken(
  requestNo: string,
  now: number,
  tokenTtlMs: number,
  clientId: string,
  iterators: number,
): string {
  const header = base64urlJson({ alg: "none", typ: "JWT" });
  const payload = base64urlJson({
    iat: now,
    exp: now + tokenTtlMs,
    iss: "nice-mock",
    clientId,
    jti: randomUUID(),
    tid: requestNo,
    iterations: iterators,
    scope: [...TOKEN_SCOPE],
  });
  const signature = randomBytes(64).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

interface SessionRow {
  request_no: string;
  client_id: string;
  access_token: string;
  ticket: string;
  iterators: number;
  token_expires_at: number;
  created_at: number;
  cert_id: string | null;
  transaction_id: string | null;
  auth_url_expires_at: number | null;
  return_url: string | null;
  close_url: string | null;
  svc_types: string | null;
  method_type: string | null;
  exp_mods: string | null;
  auth_method: string | null;
  status: string;
  identity: string | null;
  web_transaction_id: string | null;
  fail_code: string | null;
  result_fetched_at: number | null;
}

function parseStringArrayColumn(column: string, raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`store: corrupt ${column} JSON for session row: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`store: corrupt ${column} JSON for session row: expected array`);
  }
  return [...(parsed as string[])];
}

function parseIdentityColumn(raw: string | null): Identity | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`store: corrupt identity JSON for session row: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("store: corrupt identity JSON for session row: expected object");
  }
  return { ...(parsed as Identity) };
}

function rowToSession(row: SessionRow): Session {
  const session: Session = {
    requestNo: row.request_no,
    clientId: row.client_id,
    accessToken: row.access_token,
    tokenExpiresAt: row.token_expires_at,
    ticket: row.ticket,
    iterators: row.iterators,
    createdAt: row.created_at,
    status: row.status as SessionStatus,
  };
  if (row.cert_id !== null) session.certId = row.cert_id;
  if (row.transaction_id !== null) session.transactionId = row.transaction_id;
  if (row.auth_url_expires_at !== null) session.authUrlExpiresAt = row.auth_url_expires_at;
  if (row.return_url !== null) session.returnUrl = row.return_url;
  if (row.close_url !== null) session.closeUrl = row.close_url;
  const svcTypes = parseStringArrayColumn("svc_types", row.svc_types);
  if (svcTypes !== undefined) session.svcTypes = svcTypes;
  if (row.method_type !== null) session.methodType = row.method_type;
  const expMods = parseStringArrayColumn("exp_mods", row.exp_mods);
  if (expMods !== undefined) session.expMods = expMods;
  if (row.auth_method !== null) session.authMethod = row.auth_method as AuthMethod;
  const identity = parseIdentityColumn(row.identity);
  if (identity !== undefined) session.identity = identity;
  if (row.web_transaction_id !== null) session.webTransactionId = row.web_transaction_id;
  if (row.fail_code !== null) session.failCode = row.fail_code;
  if (row.result_fetched_at !== null) session.resultFetchedAt = row.result_fetched_at;
  return session;
}

export function createSession(requestNo: string, options?: CreateSessionOptions): Session {
  const now = options?.now ?? Date.now();
  const tokenTtlMs = options?.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const iterators = options?.iterators ?? 66;
  const clientId = options?.clientId ?? "test-client-id";

  const session: Session = {
    requestNo,
    clientId,
    accessToken: buildAccessToken(requestNo, now, tokenTtlMs, clientId, iterators),
    tokenExpiresAt: now + tokenTtlMs,
    ticket: randomBytes(42).toString("base64url"),
    iterators,
    createdAt: now,
    status: "CREATED",
  };

  // Rotation: DELETE any existing row for the request_no, then INSERT, in
  // ONE transaction — the old token/certId become invalid immediately.
  const db = getDb();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM sessions WHERE request_no = ?").run(requestNo);
    db.prepare(
      "INSERT INTO sessions(request_no, client_id, access_token, ticket, iterators, token_expires_at, created_at, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      session.requestNo,
      clientId,
      session.accessToken,
      session.ticket,
      session.iterators,
      session.tokenExpiresAt,
      session.createdAt,
      session.status,
    );
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* never mask the original error */
    }
    throw e;
  }
  return { ...session };
}

const SELECT_COLUMNS =
  "request_no, client_id, access_token, ticket, iterators, token_expires_at, created_at, cert_id, transaction_id, auth_url_expires_at, return_url, close_url, svc_types, method_type, exp_mods, auth_method, status, identity, web_transaction_id, fail_code, result_fetched_at";

export function loadByRequestNo(requestNo: string): Session | undefined {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM sessions WHERE request_no = ?`)
    .get(requestNo) as SessionRow | undefined;
  if (row === undefined) return undefined;
  return rowToSession(row);
}

export function loadByCertId(certId: string): Session | undefined {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM sessions WHERE cert_id = ?`)
    .get(certId) as SessionRow | undefined;
  if (row === undefined) return undefined;
  return rowToSession(row);
}

export function loadByAccessToken(accessToken: string): Session | undefined {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM sessions WHERE access_token = ?`)
    .get(accessToken) as SessionRow | undefined;
  if (row === undefined) return undefined;
  return rowToSession(row);
}

// Merge `patch` into the stored session: UPDATE SET from the patch's
// own-keys ONLY. `undefined` values become NULL (`node:sqlite` cannot bind
// `undefined`); reads map NULL back to `undefined`, so e.g.
// `updateSession(req, { failCode: undefined })` clears the field.
export function updateSession(requestNo: string, patch: Partial<Session>): Session | undefined {
  const current = loadByRequestNo(requestNo);
  if (current === undefined) return undefined;

  // clientId는 생성 후 불변: columnFor에 clientId 항목을 두지 않으므로
  // updateSession 패치 키는 무시된다 (throw 없음).
  const columnFor: Record<string, string> = {
    accessToken: "access_token",
    tokenExpiresAt: "token_expires_at",
    ticket: "ticket",
    iterators: "iterators",
    createdAt: "created_at",
    certId: "cert_id",
    transactionId: "transaction_id",
    authUrlExpiresAt: "auth_url_expires_at",
    returnUrl: "return_url",
    closeUrl: "close_url",
    svcTypes: "svc_types",
    methodType: "method_type",
    expMods: "exp_mods",
    authMethod: "auth_method",
    status: "status",
    identity: "identity",
    webTransactionId: "web_transaction_id",
    failCode: "fail_code",
    resultFetchedAt: "result_fetched_at",
  };
  const jsonColumns = new Set(["svc_types", "exp_mods", "identity"]);

  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of Object.keys(patch)) {
    const column = columnFor[key];
    if (column === undefined) continue;
    const value = patch[key as keyof Partial<Session>];
    if (value === undefined) {
      assignments.push(`${column} = ?`);
      values.push(null);
    } else if (jsonColumns.has(column)) {
      assignments.push(`${column} = ?`);
      values.push(JSON.stringify(value));
    } else if (typeof value === "string" || typeof value === "number") {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (assignments.length > 0) {
    getDb()
      .prepare(`UPDATE sessions SET ${assignments.join(", ")} WHERE request_no = ?`)
      .run(...values, requestNo);
  }
  return loadByRequestNo(requestNo);
}

export function isTokenExpired(session: Session, now: number = Date.now()): boolean {
  return now >= session.tokenExpiresAt;
}

export function isAuthWindowExpired(session: Session, now: number = Date.now()): boolean {
  if (session.authUrlExpiresAt === undefined) return false;
  return now > session.authUrlExpiresAt;
}

// Sweep token-expired sessions only. Auth-window-expired sessions are
// deliberately kept so downstream routes can answer 3032 instead of 3029.
// Returns the number of purged sessions. Never throws: when the DB is not
// initialized (or already closed — the 60s timer may fire after closeDb()),
// returns 0.
export function purgeExpired(now: number = Date.now()): number {
  try {
    const result = getDb().prepare("DELETE FROM sessions WHERE token_expires_at <= ?").run(now);
    return Number(result.changes);
  } catch {
    return 0;
  }
}

export function startPurgeTimer(
  intervalMs: number = 60_000,
  onPurge?: (purged: number) => void,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const purged = purgeExpired();
    if (purged > 0) onPurge?.(purged);
  }, intervalMs);
  timer.unref();
  return timer;
}

// Lazy sweep on top of the explicit reads is intentionally a no-op for
// deletion: expiry is evaluated by the caller (isTokenExpired /
// isAuthWindowExpired) BEFORE any purge so unknown vs expired stay
// distinct. The 60s timer owns deletion. NOTE: no top-level
// startPurgeTimer() call — importing this module must never touch the DB;
// server.ts owns the call.

export function clearStore(): void {
  getDb().exec("DELETE FROM sessions");
}

// Test/maintenance helper: empties sessions AND clients but NEVER meta
// (preserves `seeded_at` so the one-time seed stays seeded).
export function resetAll(): void {
  const db = getDb();
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM clients");
}
