import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync | null = null;
let closed = true;

const NOT_INITIALIZED = "DB not initialized: call initDb first";

export function initDb(path: string): void {
  closeDb();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS clients(client_id TEXT PRIMARY KEY, client_secret TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS sessions(request_no TEXT PRIMARY KEY, client_id TEXT NOT NULL, access_token TEXT NOT NULL UNIQUE, ticket TEXT NOT NULL, iterators INTEGER NOT NULL, token_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, cert_id TEXT UNIQUE, transaction_id TEXT, auth_url_expires_at INTEGER, return_url TEXT, close_url TEXT, svc_types TEXT, method_type TEXT, exp_mods TEXT, status TEXT NOT NULL CHECK(status IN ('CREATED','PENDING','SUCCESS','FAILED','CANCELLED')), identity TEXT, web_transaction_id TEXT, fail_code TEXT, result_fetched_at INTEGER)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  closed = false;
}

export function getDb(): DatabaseSync {
  if (db === null || closed) {
    throw new Error(NOT_INITIALIZED);
  }
  return db;
}

export function closeDb(): void {
  if (db !== null && !closed) {
    db.close();
  }
  closed = true;
}
