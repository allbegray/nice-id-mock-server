// Live dockerized e2e: drives the RUNNING mock (compose stack) over HTTP,
// then proves compatibility by decrypting the live /auth/result payload
// with the host JVM client decryptor (1:1 port of NiceIdCryptoUtils).
//
// Happy path:
//   token -> url -> GET <auth_url>?auto=1 (302 Location) -> follow to catcher
//   -> result (0000) -> java tools/jvm/ClientDecryptVerify.java -> assert identity
// Failure mode (MODE=fail, FAIL_CODE=3029|3032, default 3032):
//   injects fail=<code> via the auto URL and asserts that exact code returns.
//
// Env:
//   MOCK_BASE_URL  default http://localhost:8899
//   CLIENT_ID      default test-client-id
//   CLIENT_SECRET  default test-client-secret
//   MODE           "fail" selects failure mode (anything else = happy)
//   FAIL_CODE      3029|3032, default 3032 (only read when MODE=fail)
//
// No dependencies beyond Node builtins. Never runs inside the mock
// container: the JVM verifier spawns on THIS host (the node:26-alpine
// image has no JDK).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const MOCK_BASE_URL = process.env["MOCK_BASE_URL"] ?? "http://localhost:8899";
const CLIENT_ID = process.env["CLIENT_ID"] ?? "test-client-id";
const CLIENT_SECRET = process.env["CLIENT_SECRET"] ?? "test-client-secret";
const MODE = process.env["MODE"] ?? "";
const FAIL_CODE = process.env["FAIL_CODE"] ?? "3032";

const FETCH_TIMEOUT_MS = 10000;
const CATCHER_WAIT_MS = 10000;

function fail(message) {
  console.error(`e2e-live: FAIL: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`e2e-live: ${message}`);
}

function newRequestNo(prefix) {
  // request_no must fit the mock's 20-50 char window.
  return `${prefix}${randomBytes(16).toString("hex")}`.slice(0, 48);
}

function reqStr(body, key, where) {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    fail(`${where}: expected non-empty string at ${key}, got ${JSON.stringify(value)}`);
  }
  return value;
}

async function fetchJson(url, init, where) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    fail(`${where}: fetch to ${url} threw: ${err?.message ?? err}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    fail(`${where}: expected JSON from ${url} (HTTP ${res.status})`);
  }
  return { res, body };
}

// Ephemeral return_url catcher on 127.0.0.1:0. Resolves waiting
// consumers in arrival order; every hit answers 200 "ok".
function startCatcher() {
  return new Promise((resolve, reject) => {
    const captured = [];
    const waiters = [];
    let consumed = 0;
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const rawUrl = req.url ?? "/";
        const parsed = new URL(rawUrl, "http://127.0.0.1");
        const query = {};
        parsed.searchParams.forEach((value, key) => {
          query[key] = value;
        });
        const caught = {
          method: req.method ?? "GET",
          url: rawUrl,
          query,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        captured.push(caught);
        const waiter = waiters.shift();
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          consumed += 1;
          waiter.resolve(caught);
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok");
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => {});
        reject(new Error("catcher failed to resolve an ephemeral address"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      function waitForRequest(timeoutMs) {
        if (consumed < captured.length) {
          const next = captured[consumed];
          consumed += 1;
          return Promise.resolve(next);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const index = waiters.findIndex((entry) => entry.timer === timer);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            rej(new Error(`timed out after ${timeoutMs}ms waiting for return_url callback`));
          }, timeoutMs);
          if (typeof timer.unref === "function") {
            timer.unref();
          }
          waiters.push({ resolve: res, reject: rej, timer });
        });
      }
      function close() {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("catcher closed while waiting for a callback"));
        }
        return new Promise((res, rej) => {
          server.close((err) => {
            if (err) {
              rej(err);
              return;
            }
            res();
          });
        });
      }
      resolve({ baseUrl, close, waitForRequest });
    });
  });
}

async function main() {
  const catcher = await startCatcher().catch((err) =>
    fail(`catcher start failed: ${err?.message ?? err}`),
  );
  let catcherClosed = false;
  const closeCatcher = async () => {
    if (!catcherClosed) {
      catcherClosed = true;
      try {
        await catcher.close();
      } catch {
        // Best effort: the script is exiting anyway.
      }
    }
  };
  process.on("exit", () => {
    // Synchronous best-effort is covered by explicit closes below;
    // this handler only guards against forgotten paths.
  });

  try {
    const requestNo = newRequestNo(MODE === "fail" ? "REQLIVEFAIL" : "REQLIVE");
    const returnUrl = `${catcher.baseUrl}/nice-id/return?requestNo=${requestNo}`;
    ok(`mock=${MOCK_BASE_URL} request_no=${requestNo}`);

    // 1. Token (Basic).
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64");
    const tokenCall = await fetchJson(
      `${MOCK_BASE_URL}/ido/intc/v1.0/auth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
        body: JSON.stringify({ grant_type: "client_credentials", request_no: requestNo }),
      },
      "token",
    );
    if (tokenCall.res.status !== 200) {
      fail(
        `token: expected HTTP 200, got ${tokenCall.res.status}: ${JSON.stringify(tokenCall.body)}`,
      );
    }
    if (tokenCall.body["result_code"] !== "0000") {
      fail(`token: expected result_code 0000, got ${JSON.stringify(tokenCall.body)}`);
    }
    const accessToken = reqStr(tokenCall.body, "access_token", "token");
    const ticket = reqStr(tokenCall.body, "ticket", "token");
    const iteratorsRaw = tokenCall.body["iterators"];
    if (typeof iteratorsRaw !== "number") {
      fail(`token: expected number at iterators, got ${JSON.stringify(iteratorsRaw)}`);
    }
    const iterators = iteratorsRaw;
    ok(`token ok (result_code=0000, iterators=${iterators})`);

    // 2. auth_url (Bearer).
    const urlCall = await fetchJson(
      `${MOCK_BASE_URL}/ido/intc/v1.0/auth/url`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          request_no: requestNo,
          return_url: returnUrl,
          svc_types: ["M"],
          method_type: "GET",
        }),
      },
      "auth/url",
    );
    if (urlCall.res.status !== 200) {
      fail(
        `auth/url: expected HTTP 200, got ${urlCall.res.status}: ${JSON.stringify(urlCall.body)}`,
      );
    }
    if (urlCall.body["result_code"] !== "0000") {
      fail(`auth/url: expected result_code 0000, got ${JSON.stringify(urlCall.body)}`);
    }
    const authUrl = reqStr(urlCall.body, "auth_url", "auth/url");
    const transactionId = reqStr(urlCall.body, "transaction_id", "auth/url");
    ok(`auth_url ok (transaction_id=${transactionId})`);

    if (MODE === "fail") {
      if (FAIL_CODE !== "3029" && FAIL_CODE !== "3032") {
        fail(`MODE=fail: FAIL_CODE must be 3029 or 3032, got ${JSON.stringify(FAIL_CODE)}`);
      }
      // Inject the failure via the auto URL, then assert the result
      // surface carries that exact code.
      let failRes;
      try {
        failRes = await fetch(`${authUrl}?auto=1&fail=${FAIL_CODE}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        fail(`fail auto page: fetch threw: ${err?.message ?? err}`);
      }
      if (failRes.status !== 200) {
        fail(`fail auto page: expected HTTP 200, got ${failRes.status}`);
      }
      const failHtml = await failRes.text();
      if (!failHtml.includes(FAIL_CODE)) {
        fail(`fail auto page: expected HTML to mention ${FAIL_CODE}`);
      }
      const resultCall = await fetchJson(
        `${MOCK_BASE_URL}/ido/intc/v1.0/auth/result`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            request_no: requestNo,
            transaction_id: transactionId,
            web_transaction_id: "never-issued-wtid",
          }),
        },
        "auth/result",
      );
      if (resultCall.res.status !== 200) {
        fail(
          `auth/result: expected HTTP 200, got ${resultCall.res.status}: ${JSON.stringify(resultCall.body)}`,
        );
      }
      if (resultCall.body["result_code"] !== FAIL_CODE) {
        fail(
          `auth/result: expected result_code ${FAIL_CODE}, got ${JSON.stringify(resultCall.body)}`,
        );
      }
      ok(`fail mode ok (result_code=${FAIL_CODE})`);
      await closeCatcher();
      console.log(`e2e-live: SUMMARY mode=fail code=${FAIL_CODE} request_no=${requestNo} PASS`);
      return;
    }

    // 3. GET <auth_url>?auto=1 with manual redirect; capture Location.
    let pageRes;
    try {
      pageRes = await fetch(`${authUrl}?auto=1`, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      fail(`auto=1 page: fetch threw: ${err?.message ?? err}`);
    }
    if (pageRes.status !== 302) {
      fail(`auto=1 page: expected HTTP 302, got ${pageRes.status}`);
    }
    const location = pageRes.headers.get("location");
    await pageRes.text().catch(() => {});
    if (!location) {
      fail("auto=1 page: 302 carried no Location header");
    }
    const locationUrl = new URL(location);
    if (locationUrl.searchParams.get("requestNo") !== requestNo) {
      fail(`auto=1 page: Location requestNo mismatch: ${location}`);
    }
    const wtidFromLocation = locationUrl.searchParams.get("web_transaction_id") ?? "";
    if (wtidFromLocation === "") {
      fail(`auto=1 page: Location lacks web_transaction_id: ${location}`);
    }
    ok("auto=1 redirect ok (302 with Location)");

    // 4. Follow the redirect like a browser; the catcher must observe it.
    let followRes;
    try {
      followRes = await fetch(location, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      fail(`follow Location: fetch threw: ${err?.message ?? err}`);
    }
    if (followRes.status !== 200) {
      fail(`follow Location: expected HTTP 200 from catcher, got ${followRes.status}`);
    }
    await followRes.text().catch(() => {});
    let caught;
    try {
      caught = await catcher.waitForRequest(CATCHER_WAIT_MS);
    } catch (err) {
      fail(`catcher wait: ${err?.message ?? err}`);
    }
    if (caught.method !== "GET") {
      fail(`catcher: expected GET callback, got ${caught.method}`);
    }
    if ((caught.query["requestNo"] ?? "") !== requestNo) {
      fail(`catcher: requestNo mismatch: ${JSON.stringify(caught.query)}`);
    }
    const webTransactionId = caught.query["web_transaction_id"] ?? "";
    if (webTransactionId === "") {
      fail(`catcher: GET must carry web_transaction_id: ${JSON.stringify(caught.query)}`);
    }
    if (webTransactionId !== wtidFromLocation) {
      fail("catcher: web_transaction_id differs from the Location header value");
    }
    ok(`catcher ok (web_transaction_id=${webTransactionId})`);

    // 5. auth/result must succeed.
    const resultCall = await fetchJson(
      `${MOCK_BASE_URL}/ido/intc/v1.0/auth/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          request_no: requestNo,
          transaction_id: transactionId,
          web_transaction_id: webTransactionId,
        }),
      },
      "auth/result",
    );
    if (resultCall.res.status !== 200) {
      fail(
        `auth/result: expected HTTP 200, got ${resultCall.res.status}: ${JSON.stringify(resultCall.body)}`,
      );
    }
    if (resultCall.body["result_code"] !== "0000") {
      fail(`auth/result: expected result_code 0000, got ${JSON.stringify(resultCall.body)}`);
    }
    const encData = reqStr(resultCall.body, "enc_data", "auth/result");
    const integrityValue = reqStr(resultCall.body, "integrity_value", "auth/result");
    console.log(
      `e2e-live: auth/result body: ${JSON.stringify({ result_code: resultCall.body["result_code"] })}`,
    );
    ok("auth/result ok (result_code=0000)");

    // 6. Host JVM client decryptor: the compatibility proof.
    const proc = spawnSync(
      "java",
      [
        "tools/jvm/ClientDecryptVerify.java",
        ticket,
        String(iterators),
        transactionId,
        encData,
        integrityValue,
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    if (proc.error) {
      fail(`JVM verifier: spawn failed: ${proc.error.message}`);
    }
    if (proc.status !== 0) {
      fail(`JVM verifier: exit ${proc.status}: ${(proc.stderr ?? "").trim()}`);
    }
    const stdout = (proc.stdout ?? "").trim();
    console.log(`e2e-live: JVM verifier output: ${stdout}`);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      fail(`JVM verifier: stdout is not JSON: ${stdout.slice(0, 200)}`);
    }
    if (parsed?.["name"] !== "홍길동") {
      fail(`JVM verifier: expected name 홍길동, got ${JSON.stringify(parsed?.["name"])}`);
    }
    if (parsed?.["mobile_no"] !== "01012345678") {
      fail(
        `JVM verifier: expected mobile_no 01012345678, got ${JSON.stringify(parsed?.["mobile_no"])}`,
      );
    }
    ok("JVM decrypt ok (name=홍길동 mobile_no=01012345678)");

    await closeCatcher();
    console.log(`e2e-live: SUMMARY mode=happy result_code=0000 request_no=${requestNo} PASS`);
  } catch (err) {
    await closeCatcher();
    if (err instanceof Error) {
      fail(`unexpected error: ${err.message}`);
    }
    fail(`unexpected error: ${String(err)}`);
  }
}

await main();
