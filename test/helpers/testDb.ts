import { closeDb, initDb } from "../../src/db.ts";

export function initTestDb(seed?: () => void): void {
  // Quiet by default: buildApp() enables the Fastify logger unless
  // LOG_LEVEL=silent, which would flood tap output. A test that wants to
  // assert on log lines sets LOG_LEVEL explicitly (see test/logging.test.ts).
  if (process.env["LOG_LEVEL"] === undefined) {
    process.env["LOG_LEVEL"] = "silent";
  }
  initDb(":memory:");
  if (seed) seed();
}

export function closeTestDb(): void {
  closeDb();
}
