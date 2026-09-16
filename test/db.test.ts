import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeDb, getDb, initDb } from "../src/db.ts";
import { closeTestDb, initTestDb } from "./helpers/testDb.ts";

describe("db layer", () => {
  it("(4) getDb() before any init throws /not initialized/", () => {
    closeDb();
    assert.throws(() => getDb(), /not initialized/);
  });

  it("(5) closeDb(); getDb() throws", () => {
    initTestDb();
    try {
      closeTestDb();
      assert.throws(() => getDb(), /not initialized/);
    } finally {
      closeDb();
    }
  });

  it("(1) all 3 tables exist in sqlite_master", () => {
    initTestDb();
    try {
      const rows = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?)")
        .all("clients", "sessions", "meta") as { name: string }[];
      const names = rows.map((r) => r.name).sort();
      assert.deepEqual(names, ["clients", "meta", "sessions"]);
    } finally {
      closeTestDb();
    }
  });

  it("(2) temp-dir file path creates the file AND journal_mode is wal", () => {
    const dir = mkdtempSync(join(tmpdir(), "niceid-db-test-"));
    const dbPath = join(dir, "test.db");
    try {
      initDb(dbPath);
      try {
        assert.equal(existsSync(dbPath), true);
        const row = getDb().prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        };
        assert.equal(row.journal_mode, "wal");
      } finally {
        closeDb();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(3) double initDb on the same path is error-free", () => {
    const dir = mkdtempSync(join(tmpdir(), "niceid-db-test-"));
    const dbPath = join(dir, "test.db");
    try {
      initDb(dbPath);
      initDb(dbPath);
      getDb().prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("k", "v");
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(6) :memory: initDb + DDL/DML round-trip works", () => {
    initTestDb();
    try {
      getDb().exec("CREATE TABLE t_roundtrip (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
      getDb().prepare("INSERT INTO t_roundtrip (v) VALUES (?)").run("hello");
      const row = getDb().prepare("SELECT v FROM t_roundtrip").get() as {
        v: string;
      };
      assert.equal(row.v, "hello");
      getDb().exec("DROP TABLE t_roundtrip");
    } finally {
      closeTestDb();
    }
  });
});
