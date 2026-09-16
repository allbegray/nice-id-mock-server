import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

// Captured return_url callback: one HTTP hit against the catcher,
// whether the mock delivered it as a GET redirect or a POST auto-submit.
export interface CaughtRequest {
  method: string;
  url: string;
  query: Record<string, string>;
  body: string;
}

interface Waiter {
  resolve: (request: CaughtRequest) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ReturnCatcher {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: readonly CaughtRequest[];
  waitForRequest(timeoutMs: number): Promise<CaughtRequest>;
  close(): Promise<void>;
}

// Ephemeral local catcher for return_url callbacks. Binds 127.0.0.1:0
// (no fixed ports), answers every hit with 200 "ok", and records
// {method, url, query, body} in arrival order. No external dependencies.
export async function startReturnCatcher(): Promise<ReturnCatcher> {
  const captured: CaughtRequest[] = [];
  const waiters: Waiter[] = [];
  let consumed = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const rawUrl = req.url ?? "/";
      const parsed = new URL(rawUrl, "http://127.0.0.1");
      const query: Record<string, string> = {};
      parsed.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      const caught: CaughtRequest = {
        method: req.method ?? "GET",
        url: rawUrl,
        query,
        body,
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw new Error("return catcher failed to resolve an ephemeral address");
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  function waitForRequest(timeoutMs: number): Promise<CaughtRequest> {
    if (consumed < captured.length) {
      const next = captured[consumed];
      if (next === undefined) {
        throw new Error("return catcher consumed index out of range");
      }
      consumed += 1;
      return Promise.resolve(next);
    }
    return new Promise<CaughtRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error(`timed out after ${timeoutMs}ms waiting for return_url callback`));
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      waiters.push({ resolve, reject, timer });
    });
  }

  async function close(): Promise<void> {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("return catcher closed while waiting for a callback"));
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return { baseUrl, port, requests: captured, waitForRequest, close };
}
