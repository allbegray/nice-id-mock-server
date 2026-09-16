import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createClient,
  deleteClient,
  findClient,
  listClients,
  maskSecret,
  seedDefaultClientIfEmpty,
  updateClientSecret,
  validateClientCredentials,
} from "../src/clients.ts";
import { getDb } from "../src/db.ts";
import { closeTestDb, initTestDb } from "./helpers/testDb.ts";

describe("clients repository", () => {
  it("create -> find returns the same values", () => {
    initTestDb();
    try {
      const now = 1_700_000_000_000;
      const created = createClient("test-client-id", "test-client-secret", now);
      assert.ok(created);
      assert.equal(created.clientId, "test-client-id");
      assert.equal(created.clientSecret, "test-client-secret");
      assert.equal(created.createdAt, now);
      assert.equal(created.updatedAt, now);
      const found = findClient("test-client-id");
      assert.deepEqual(found, created);
    } finally {
      closeTestDb();
    }
  });

  it("duplicate create returns undefined", () => {
    initTestDb();
    try {
      const first = createClient("dup-id", "secret-1", 1000);
      assert.ok(first);
      const second = createClient("dup-id", "secret-2", 2000);
      assert.equal(second, undefined);
      // original row untouched
      assert.equal(findClient("dup-id")?.clientSecret, "secret-1");
    } finally {
      closeTestDb();
    }
  });

  it("findClient on missing id returns undefined", () => {
    initTestDb();
    try {
      assert.equal(findClient("no-such-client"), undefined);
    } finally {
      closeTestDb();
    }
  });

  it("listClients returns rows ordered by client_id", () => {
    initTestDb();
    try {
      createClient("c-id", "s", 1000);
      createClient("a-id", "s", 1000);
      createClient("b-id", "s", 1000);
      const ids = listClients().map((c) => c.clientId);
      assert.deepEqual(ids, ["a-id", "b-id", "c-id"]);
    } finally {
      closeTestDb();
    }
  });

  it("updateClientSecret updates secret and updatedAt", () => {
    initTestDb();
    try {
      createClient("upd-id", "old-secret", 1000);
      const updated = updateClientSecret("upd-id", "new-secret", 2000);
      assert.ok(updated);
      assert.equal(updated.clientSecret, "new-secret");
      assert.equal(updated.createdAt, 1000);
      assert.equal(updated.updatedAt, 2000);
      assert.equal(findClient("upd-id")?.clientSecret, "new-secret");
    } finally {
      closeTestDb();
    }
  });

  it("updateClientSecret on missing id returns undefined", () => {
    initTestDb();
    try {
      assert.equal(updateClientSecret("ghost", "s", 1000), undefined);
    } finally {
      closeTestDb();
    }
  });

  it("deleteClient returns true then false", () => {
    initTestDb();
    try {
      createClient("del-id", "s", 1000);
      assert.equal(deleteClient("del-id"), true);
      assert.equal(findClient("del-id"), undefined);
      assert.equal(deleteClient("del-id"), false);
    } finally {
      closeTestDb();
    }
  });

  it("validateClientCredentials true on match, false on mismatch/missing", () => {
    initTestDb();
    try {
      createClient("v-id", "correct-secret", 1000);
      assert.equal(validateClientCredentials("v-id", "correct-secret"), true);
      assert.equal(validateClientCredentials("v-id", "wrong-secret"), false);
      assert.equal(validateClientCredentials("missing-id", "correct-secret"), false);
    } finally {
      closeTestDb();
    }
  });

  it("maskSecret: 8-char input keeps 4-char proof, 4-char input yields ****", () => {
    assert.equal(maskSecret("test-secret"), "test****");
    assert.equal(maskSecret("abcd"), "****");
    assert.equal(maskSecret("abc"), "****");
    assert.equal(maskSecret(""), "****");
  });

  it("seed truth-table (1): first boot with no meta row seeds env values", () => {
    initTestDb();
    try {
      const seeded = seedDefaultClientIfEmpty("test-client-id", "test-client-secret", 1000);
      assert.equal(seeded, true);
      const found = findClient("test-client-id");
      assert.ok(found);
      assert.equal(found.clientSecret, "test-client-secret");
      assert.equal(validateClientCredentials("test-client-id", "test-client-secret"), true);
    } finally {
      closeTestDb();
    }
  });

  it("seed truth-table (2): later empty table on restart does NOT re-seed", () => {
    initTestDb();
    try {
      assert.equal(seedDefaultClientIfEmpty("test-client-id", "test-client-secret", 1000), true);
      // admin deletes everything — valid empty state, marker must survive
      for (const c of listClients()) {
        assert.equal(deleteClient(c.clientId), true);
      }
      assert.deepEqual(listClients(), []);
      const reseeded = seedDefaultClientIfEmpty("test-client-id", "test-client-secret", 2000);
      assert.equal(reseeded, false);
      assert.deepEqual(listClients(), []);
      // recovery is admin-create only
      const manual = createClient("admin-created", "s", 3000);
      assert.ok(manual);
    } finally {
      closeTestDb();
    }
  });

  it("seed is one-shot even without deletes: second call returns false", () => {
    initTestDb();
    try {
      assert.equal(seedDefaultClientIfEmpty("test-client-id", "test-client-secret", 1000), true);
      assert.equal(seedDefaultClientIfEmpty("other-id", "other-secret", 2000), false);
      assert.equal(findClient("other-id"), undefined);
      // marker row persisted in meta
      const marker = getDb().prepare("SELECT value FROM meta WHERE key = ?").get("seeded_at") as
        | { value: string }
        | undefined;
      assert.ok(marker);
    } finally {
      closeTestDb();
    }
  });
});
