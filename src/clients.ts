import { getDb } from "./db.ts";
import type { Client } from "./types.ts";

interface ClientRow {
  client_id: string;
  client_secret: string;
  created_at: number;
  updated_at: number;
}

function mapRow(row: ClientRow): Client {
  return {
    clientId: row.client_id,
    clientSecret: row.client_secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createClient(clientId: string, clientSecret: string, now?: number): Client | undefined {
  const ts = now ?? Date.now();
  const result = getDb()
    .prepare("INSERT OR IGNORE INTO clients(client_id, client_secret, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(clientId, clientSecret, ts, ts);
  if (Number(result.changes) === 0) {
    return undefined;
  }
  return findClient(clientId);
}

export function findClient(clientId: string): Client | undefined {
  const row = getDb()
    .prepare("SELECT client_id, client_secret, created_at, updated_at FROM clients WHERE client_id = ?")
    .get(clientId) as ClientRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

export function listClients(): Client[] {
  const rows = getDb()
    .prepare("SELECT client_id, client_secret, created_at, updated_at FROM clients ORDER BY client_id")
    .all() as unknown as ClientRow[];
  return rows.map(mapRow);
}

export function updateClientSecret(
  clientId: string,
  clientSecret: string,
  now?: number,
): Client | undefined {
  const ts = now ?? Date.now();
  const result = getDb()
    .prepare("UPDATE clients SET client_secret = ?, updated_at = ? WHERE client_id = ?")
    .run(clientSecret, ts, clientId);
  if (Number(result.changes) === 0) {
    return undefined;
  }
  return findClient(clientId);
}

export function deleteClient(clientId: string): boolean {
  const result = getDb().prepare("DELETE FROM clients WHERE client_id = ?").run(clientId);
  return Number(result.changes) !== 0;
}

export function validateClientCredentials(clientId: string, clientSecret: string): boolean {
  // Intentional plain `===` comparison: this is a local dev mock, secrets are
  // stored in plaintext by design (see Decisions: secret 저장/노출). Never use
  // this pattern outside the mock.
  const found = findClient(clientId);
  if (found === undefined) {
    return false;
  }
  return found.clientSecret === clientSecret;
}

// Seed truth table (local mock, one-shot bootstrap):
// (1) First boot (no `meta.seeded_at` row + empty table) → seed env values, return true.
// (2) Later empty table on restart (marker exists) → NO seed, return false.
//     Deleting all clients is a valid state; recovery is admin-create only.
// (3) `STRICT_CREDENTIALS=false` bypasses DB lookup entirely — enforced in
//     authToken, NOT here (do not implement it in this module).
// (4) Existing tokens stay valid until TTL after client deletion (sessions are
//     independent rows; enforced by the session layer, not here).
export function seedDefaultClientIfEmpty(clientId: string, clientSecret: string, now?: number): boolean {
  const marker = getDb().prepare("SELECT value FROM meta WHERE key = ?").get("seeded_at") as
    | { value: string }
    | undefined;
  if (marker !== undefined) {
    return false;
  }
  const ts = now ?? Date.now();
  getDb()
    .prepare("INSERT OR IGNORE INTO clients(client_id, client_secret, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(clientId, clientSecret, ts, ts);
  getDb().prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)").run("seeded_at", String(ts));
  return true;
}

export function maskSecret(secret: string): string {
  return secret.length <= 4 ? "****" : `${secret.slice(0, 4)}****`;
}
