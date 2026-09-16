import { randomBytes, randomUUID } from "node:crypto";
import type { Session } from "./types.ts";

// In-memory session store for the NICE mock server. No persistence:
// a restart clears all state by design.
//
// Three indexes:
// - sessionsByRequestNo: request_no -> Session (primary)
// - sessionsByCertId: certId -> request_no (표준창 lookup)
// - sessionsByAccessToken: accessToken -> request_no (Bearer validation)
//
// Expiry model (mirrors Token.kt `now >= expiresIn`):
// - Token expiry boundary: `now >= tokenExpiresAt` counts as expired.
// - Auth-window expiry boundary: `now > authUrlExpiresAt` (strict).
// - Reads never purge. purgeExpired() removes ONLY token-expired
//   sessions — NEVER auth-window-expired ones, because routes must still
//   return 3032 (not 3029) for those. Expired sessions stay in the map
//   until the 60s sweep so unknown -> 1004 stays distinct from
//   expired -> 1003.

export const DEFAULT_TOKEN_TTL_MS = 86400000;

export const sessionsByRequestNo = new Map<string, Session>();
export const sessionsByCertId = new Map<string, string>();
export const sessionsByAccessToken = new Map<string, string>();

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

function removeIndexes(session: Session): void {
  if (session.certId !== undefined) {
    if (sessionsByCertId.get(session.certId) === session.requestNo) {
      sessionsByCertId.delete(session.certId);
    }
  }
  if (sessionsByAccessToken.get(session.accessToken) === session.requestNo) {
    sessionsByAccessToken.delete(session.accessToken);
  }
}

export function createSession(requestNo: string, options?: CreateSessionOptions): Session {
  const now = options?.now ?? Date.now();
  const tokenTtlMs = options?.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const iterators = options?.iterators ?? 66;
  const clientId = options?.clientId ?? "test-client-id";

  const previous = sessionsByRequestNo.get(requestNo);
  if (previous !== undefined) {
    // Rotation: drop stale index entries so the old token/certId resolve
    // to unknown (1004 / 404) instead of the rotated session.
    removeIndexes(previous);
  }

  const session: Session = {
    requestNo,
    accessToken: buildAccessToken(requestNo, now, tokenTtlMs, clientId, iterators),
    tokenExpiresAt: now + tokenTtlMs,
    ticket: randomBytes(42).toString("base64url"),
    iterators,
    createdAt: now,
    status: "CREATED",
  };
  sessionsByRequestNo.set(requestNo, session);
  sessionsByAccessToken.set(session.accessToken, requestNo);
  return { ...session };
}

function copySession(session: Session): Session {
  return {
    ...session,
    svcTypes: session.svcTypes === undefined ? undefined : [...session.svcTypes],
    expMods: session.expMods === undefined ? undefined : [...session.expMods],
    identity: session.identity === undefined ? undefined : { ...session.identity },
  };
}

export function loadByRequestNo(requestNo: string): Session | undefined {
  const session = sessionsByRequestNo.get(requestNo);
  return session === undefined ? undefined : copySession(session);
}

export function loadByCertId(certId: string): Session | undefined {
  const requestNo = sessionsByCertId.get(certId);
  if (requestNo === undefined) return undefined;
  return loadByRequestNo(requestNo);
}

export function loadByAccessToken(accessToken: string): Session | undefined {
  const requestNo = sessionsByAccessToken.get(accessToken);
  if (requestNo === undefined) return undefined;
  return loadByRequestNo(requestNo);
}

// Merge `patch` into the stored session and keep the secondary indexes in
// sync: changing accessToken or certId deletes the stale index entry and
// registers the new one, so rotation (repeat token/url issuance performed
// by the route layer) invalidates the previous values.
export function updateSession(requestNo: string, patch: Partial<Session>): Session | undefined {
  const current = sessionsByRequestNo.get(requestNo);
  if (current === undefined) return undefined;

  if ("accessToken" in patch && patch.accessToken !== current.accessToken) {
    if (sessionsByAccessToken.get(current.accessToken) === requestNo) {
      sessionsByAccessToken.delete(current.accessToken);
    }
  }
  if ("certId" in patch && patch.certId !== current.certId) {
    if (current.certId !== undefined && sessionsByCertId.get(current.certId) === requestNo) {
      sessionsByCertId.delete(current.certId);
    }
  }

  const updated: Session = { ...current, ...patch, requestNo: current.requestNo };
  sessionsByRequestNo.set(requestNo, updated);
  if (updated.accessToken !== undefined) {
    sessionsByAccessToken.set(updated.accessToken, requestNo);
  }
  if (updated.certId !== undefined) {
    sessionsByCertId.set(updated.certId, requestNo);
  }
  return copySession(updated);
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
// Returns the number of purged sessions.
export function purgeExpired(now: number = Date.now()): number {
  let purged = 0;
  for (const session of sessionsByRequestNo.values()) {
    if (isTokenExpired(session, now)) {
      sessionsByRequestNo.delete(session.requestNo);
      removeIndexes(session);
      purged += 1;
    }
  }
  return purged;
}

export function startPurgeTimer(intervalMs: number = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    purgeExpired();
  }, intervalMs);
  timer.unref();
  return timer;
}

// Lazy sweep on top of the explicit reads is intentionally a no-op for
// deletion: expiry is evaluated by the caller (isTokenExpired /
// isAuthWindowExpired) BEFORE any purge so unknown vs expired stay
// distinct. The 60s timer owns deletion.
startPurgeTimer();

export function clearStore(): void {
  sessionsByRequestNo.clear();
  sessionsByCertId.clear();
  sessionsByAccessToken.clear();
}
