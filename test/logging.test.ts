import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildApp } from "../src/app.ts";
import { createClient } from "../src/clients.ts";
import { loadConfig } from "../src/config.ts";
import { closeTestDb, initTestDb } from "./helpers/testDb.ts";

const REQUEST_NO = "REQ12345678901234567890";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";

interface LogLine {
  level: number;
  msg: string;
  route?: string;
  result_code?: string;
  reason?: string;
  [key: string]: unknown;
}

function collectStream(): { stream: Writable; lines: () => LogLine[] } {
  let buffer = "";
  const stream = new Writable({
    write(chunk, _encoding, callback): void {
      buffer += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      buffer
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as LogLine),
  };
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64url")}`;
}

describe("LOG_LEVEL config", () => {
  it("defaults to info", () => {
    assert.equal(loadConfig({}).logLevel, "info");
  });

  it("accepts every pino level (case-insensitive) and silent", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "silent"]) {
      assert.equal(loadConfig({ LOG_LEVEL: level }).logLevel, level);
    }
    assert.equal(loadConfig({ LOG_LEVEL: "DEBUG" }).logLevel, "debug");
  });

  it("rejects unknown levels", () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /Invalid LOG_LEVEL/);
  });
});

describe("request logging", () => {
  beforeEach(() => {
    initTestDb();
    createClient(CLIENT_ID, CLIENT_SECRET);
  });

  afterEach(() => {
    closeTestDb();
  });

  it("token issuance logs full values plus a request-completed line", async () => {
    const { stream, lines } = collectStream();
    const app = buildApp({ logLevel: "info" }, { logStream: stream });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/token",
        headers: {
          authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
          "content-type": "application/json",
        },
        payload: { grant_type: "client_credentials", request_no: REQUEST_NO },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { access_token: string; ticket: string };
      await new Promise((resolve) => setImmediate(resolve));

      const issued = lines().find((line) => line.msg === "토큰 발급 성공");
      assert.ok(issued, "expected a '토큰 발급 성공' line");
      assert.equal(issued?.result_code, "0000");
      assert.equal(issued?.request_no, REQUEST_NO);
      // Local mock: full values, no truncation.
      assert.equal(issued?.access_token, body.access_token);
      assert.equal(issued?.ticket, body.ticket);

      const completed = lines().find((line) => line.msg === "요청 완료");
      assert.ok(completed, "expected a '요청 완료' line");
      assert.equal(completed?.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("rejections carry result_code/reason and never the credential values", async () => {
    const { stream, lines } = collectStream();
    const app = buildApp({ logLevel: "info" }, { logStream: stream });
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/token",
        headers: { "content-type": "application/json" },
        payload: { grant_type: "client_credentials", request_no: REQUEST_NO },
      });
      assert.equal(missing.statusCode, 400);

      const wrongSecret = "not-the-real-secret";
      const rejected = await app.inject({
        method: "POST",
        url: "/ido/intc/v1.0/auth/token",
        headers: {
          authorization: basicAuth(CLIENT_ID, wrongSecret),
          "content-type": "application/json",
        },
        payload: { grant_type: "client_credentials", request_no: REQUEST_NO },
      });
      assert.equal(rejected.statusCode, 400);
      await new Promise((resolve) => setImmediate(resolve));

      const all = lines();
      const noAuth = all.find(
        (line) => line.msg === "토큰 발급 거부" && line.reason === "missing_authorization",
      );
      assert.ok(noAuth, "expected a missing_authorization line");
      assert.equal(noAuth?.result_code, "1001");

      const unknownClient = all.find(
        (line) => line.msg === "토큰 발급 거부" && line.reason === "unknown_client",
      );
      assert.ok(unknownClient, "expected an unknown_client line");
      assert.equal(unknownClient?.result_code, "1006");
      assert.equal(unknownClient?.client_id, CLIENT_ID);

      const raw = all.map((line) => JSON.stringify(line)).join("\n");
      assert.ok(!raw.includes(wrongSecret), "presented secret must not appear in logs");
      assert.ok(!raw.includes("Basic "), "authorization header must not appear in logs");
    } finally {
      await app.close();
    }
  });
});
