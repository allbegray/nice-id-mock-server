import { buildApp } from "./app.ts";
import { seedDefaultClientIfEmpty } from "./clients.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { closeDb, initDb } from "./db.ts";
import { startPurgeTimer } from "./store.ts";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDbOpenFailure(err: unknown): boolean {
  if (!isRecord(err)) return false;
  // mkdirSync stage: parent is a file (ENOTDIR, or EEXIST from recursive
  // mkdir when the parent path exists as a file) or unwritable dir (EACCES).
  if (err["code"] === "ENOTDIR" || err["code"] === "EACCES") return true;
  if (err["code"] === "EEXIST" && err["syscall"] === "mkdir") return true;
  // SQLite open stage (measured): new DatabaseSync(badPath) throws
  // code=ERR_SQLITE_ERROR, errcode=14, errstr='unable to open database file'.
  // There is no string code like 'SQLITE_CANTOPEN' — match errcode 14 or
  // code + message instead.
  if (err["errcode"] === 14) return true;
  if (
    err["code"] === "ERR_SQLITE_ERROR" &&
    typeof err["message"] === "string" &&
    /unable to open database file/.test(err["message"])
  ) {
    return true;
  }
  return false;
}

function formatDbError(err: unknown, dbPath: string): string {
  const detail = err instanceof Error ? err.message : String(err);
  const hint = isDbOpenFailure(err)
    ? " Check that the parent directory exists, is a directory (not a file), and is writable."
    : " Check that DB_PATH points to a writable location.";
  return `Failed to open SQLite database at "${dbPath}": ${detail}.${hint}`;
}

try {
  initDb(config.dbPath);
} catch (err) {
  console.error(formatDbError(err, config.dbPath));
  process.exit(1);
}

try {
  seedDefaultClientIfEmpty(config.clientId, config.clientSecret);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = buildApp(config);

// Order: app closes first, then the DB closes inside the onClose hook.
// closeDb() is idempotent so double-close (hook + signal path) is safe.
app.addHook("onClose", async () => {
  closeDb();
});

startPurgeTimer();

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void app.close().then(
    () => {
      process.exit(0);
    },
    (err: unknown) => {
      app.log.error(err);
      process.exit(1);
    },
  );
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`nice-id-mock-server listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
