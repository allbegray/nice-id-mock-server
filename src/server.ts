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

startPurgeTimer(60_000, (purged) => {
  app.log.info({ purged }, "만료 세션 정리");
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "종료 신호 수신");
  void app.close().then(
    () => {
      app.log.info("서버 종료");
      process.exit(0);
    },
    (err: unknown) => {
      app.log.error(err);
      process.exit(1);
    },
  );
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

process.once("unhandledRejection", (reason: unknown) => {
  app.log.error({ err: reason }, "처리되지 않은 rejection");
});
process.once("uncaughtException", (err: unknown) => {
  app.log.error({ err }, "처리되지 않은 예외");
});

try {
  await app.listen({ port: config.port, host: config.host });
  // Secrets (clientSecret) are deliberately excluded here.
  app.log.info(
    {
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      dbPath: config.dbPath,
      logLevel: config.logLevel,
      strictCredentials: config.strictCredentials,
      tokenTtlMs: config.tokenTtlMs,
      authUrlTtlMs: config.authUrlTtlMs,
      strictOneTimeResult: config.strictOneTimeResult,
    },
    `nice-id-mock-server listening on http://${config.host}:${config.port}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
