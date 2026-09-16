import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb } from "../src/db.ts";
import { createClient, findClient, listClients, seedDefaultClientIfEmpty } from "../src/clients.ts";
import {
  createSession,
  isAuthWindowExpired,
  isTokenExpired,
  loadByAccessToken,
  loadByCertId,
  loadByRequestNo,
  purgeExpired,
  resetAll,
  updateSession,
} from "../src/store.ts";
import type { Identity } from "../src/types.ts";

// Restart-persistence proof: every case uses a unique mkdtempSync dir under
// the OS tmpdir (never a fixed /tmp path, never the repo data/ dir) and
// removes it in `finally`. WAL sidecars (-wal/-shm) are never asserted:
// their existence is platform/journal-mode dependent.

function makeFileDb(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "niceid-persist-"));
  return { dir, file: join(dir, "test.db") };
}

function cleanupDir(dir: string): void {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(!existsSync(dir), `temp dir not cleaned: ${dir}`);
}

const IDENTITY: Identity = {
  name: "홍길동",
  birthdate: "19000208",
  gender: "1",
  nationalInfo: "0",
  mobileCo: "SKT",
  mobileNo: "01012345678",
};

describe("restart persistence", () => {
  it("1. client survives reopen: findClient/listClients return identical rows", () => {
    const { dir, file } = makeFileDb();
    try {
      initDb(file);
      const created = createClient("persist-client-id", "persist-client-secret", 1700000000000);
      assert.ok(created !== undefined);
      const beforeFind = findClient("persist-client-id");
      const beforeList = listClients();
      assert.deepEqual(beforeFind, created);

      closeDb();
      initDb(file);

      assert.deepEqual(findClient("persist-client-id"), beforeFind);
      assert.deepEqual(listClients(), beforeList);
    } finally {
      cleanupDir(dir);
    }
  });

  it("2. SUCCESS session survives reopen on all three loaders with identity + JSON round-trip", () => {
    const { dir, file } = makeFileDb();
    try {
      initDb(file);
      const now = 1700000000000;
      const created = createSession("PERSIST-REQ-00000000001", { now, tokenTtlMs: 86400000 });
      const updated = updateSession("PERSIST-REQ-00000000001", {
        certId: "persist-cert-id-001",
        transactionId: "persist-tx-001",
        authUrlExpiresAt: now + 600000,
        returnUrl: "http://localhost:8080/nice-id/return?requestNo=PERSIST-REQ-00000000001",
        svcTypes: ["M", "U"],
        methodType: "GET",
        expMods: ["model", "carrier"],
        status: "SUCCESS",
        identity: { ...IDENTITY },
        webTransactionId: "persist-wtid-001",
      });
      assert.ok(updated !== undefined);
      assert.equal(updated.status, "SUCCESS");

      closeDb();
      initDb(file);

      const byReq = loadByRequestNo("PERSIST-REQ-00000000001");
      const byToken = loadByAccessToken(created.accessToken);
      const byCert = loadByCertId("persist-cert-id-001");
      assert.ok(byReq !== undefined);
      assert.ok(byToken !== undefined);
      assert.ok(byCert !== undefined);
      for (const loaded of [byReq, byToken, byCert]) {
        assert.equal(loaded.requestNo, "PERSIST-REQ-00000000001");
        assert.equal(loaded.accessToken, created.accessToken);
        assert.equal(loaded.status, "SUCCESS");
        assert.deepEqual(loaded.identity, IDENTITY);
        assert.deepEqual(loaded.svcTypes, ["M", "U"]);
        assert.deepEqual(loaded.expMods, ["model", "carrier"]);
        assert.equal(loaded.methodType, "GET");
        assert.equal(loaded.webTransactionId, "persist-wtid-001");
      }

      // Direct SELECT: JSON columns stored as text round-trip through reopen.
      const raw = getDb()
        .prepare("SELECT svc_types, exp_mods, identity FROM sessions WHERE request_no = ?")
        .get("PERSIST-REQ-00000000001") as {
        svc_types: string;
        exp_mods: string;
        identity: string;
      };
      assert.deepEqual(JSON.parse(raw.svc_types), ["M", "U"]);
      assert.deepEqual(JSON.parse(raw.exp_mods), ["model", "carrier"]);
      assert.deepEqual(JSON.parse(raw.identity), IDENTITY);
    } finally {
      cleanupDir(dir);
    }
  });

  it("3. TTL boundary survives reopen: isTokenExpired (>=) holds on both sides", () => {
    const { dir, file } = makeFileDb();
    try {
      const now = 1700000000000;
      initDb(file);
      const created = createSession("PERSIST-REQ-00000000002", { now, tokenTtlMs: 1000 });
      assert.equal(created.tokenExpiresAt, now + 1000);
      assert.equal(isTokenExpired(created, now + 999), false);
      assert.equal(isTokenExpired(created, now + 1000), true);

      closeDb();
      initDb(file);

      const reloaded = loadByRequestNo("PERSIST-REQ-00000000002");
      assert.ok(reloaded !== undefined);
      assert.equal(reloaded.tokenExpiresAt, now + 1000);
      assert.equal(isTokenExpired(reloaded, now + 999), false);
      assert.equal(isTokenExpired(reloaded, now + 1000), true);
    } finally {
      cleanupDir(dir);
    }
  });

  it("4. purge semantics survive reopen: token-expired purged, auth-window-expired kept queryable", () => {
    const { dir, file } = makeFileDb();
    try {
      const now = 1700000000000;
      initDb(file);
      // Token-expired row: short TTL, swept by purgeExpired.
      createSession("PERSIST-REQ-TOKEN-EXPIRED1", { now, tokenTtlMs: 1000 });
      // Auth-window-expired row (the 3032 path): token still valid, but the
      // cert window lapsed. purgeExpired must NEVER delete it.
      createSession("PERSIST-REQ-AUTHWIN-EXPIRE1", { now, tokenTtlMs: 86400000 });
      updateSession("PERSIST-REQ-AUTHWIN-EXPIRE1", {
        certId: "persist-cert-authwin-001",
        transactionId: "persist-tx-authwin-001",
        authUrlExpiresAt: now + 600000,
        status: "PENDING",
      });

      closeDb();
      initDb(file);

      // Both rows survive the restart itself (reads never purge).
      assert.ok(loadByRequestNo("PERSIST-REQ-TOKEN-EXPIRED1") !== undefined);
      assert.ok(loadByRequestNo("PERSIST-REQ-AUTHWIN-EXPIRE1") !== undefined);

      // Sweep after the 10-min auth window lapses but while the kept row's
      // 24h token is still valid: only the token-expired row is swept.
      const sweepNow = now + 600001;
      const purged = purgeExpired(sweepNow);
      assert.equal(purged, 1);

      // Token-expired row is gone from every index...
      assert.equal(loadByRequestNo("PERSIST-REQ-TOKEN-EXPIRED1"), undefined);
      // ...while the auth-window-expired row survives AND stays queryable
      // (routes need it to answer 3032, not 3029).
      const kept = loadByRequestNo("PERSIST-REQ-AUTHWIN-EXPIRE1");
      assert.ok(kept !== undefined);
      assert.equal(isTokenExpired(kept, sweepNow), false);
      assert.equal(isAuthWindowExpired(kept, sweepNow), true);
      assert.ok(loadByCertId("persist-cert-authwin-001") !== undefined);
      assert.ok(loadByAccessToken(kept.accessToken) !== undefined);
    } finally {
      cleanupDir(dir);
    }
  });

  it("5. seed-once across restart: resetAll then reseed creates nothing", () => {
    const { dir, file } = makeFileDb();
    try {
      initDb(file);
      assert.equal(seedDefaultClientIfEmpty("seed-client-id", "seed-client-secret", 1700000000000), true);
      assert.ok(findClient("seed-client-id") !== undefined);

      // Delete-all (keeps meta.seeded_at by design), then restart.
      resetAll();
      assert.deepEqual(listClients(), []);

      closeDb();
      initDb(file);

      assert.equal(seedDefaultClientIfEmpty("seed-client-id", "seed-client-secret", 1700000000001), false);
      assert.deepEqual(listClients(), []);
      assert.equal(findClient("seed-client-id"), undefined);
    } finally {
      cleanupDir(dir);
    }
  });
});
