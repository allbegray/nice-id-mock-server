import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import Fastify, { LogController } from "fastify";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import adminRoutes from "./routes/admin.ts";
import authResultRoutes from "./routes/authResult.ts";
import authTokenRoutes from "./routes/authToken.ts";
import authUrlRoutes from "./routes/authUrl.ts";
import certWindowRoutes from "./routes/certWindow.ts";

const certHtmlPath = join(dirname(fileURLToPath(import.meta.url)), "web", "cert.html");

export async function readCertHtml(): Promise<string | undefined> {
  try {
    return await readFile(certHtmlPath, "utf8");
  } catch {
    return undefined;
  }
}

const adminHtmlPath = join(dirname(fileURLToPath(import.meta.url)), "web", "admin.html");

export async function readAdminHtml(): Promise<string | undefined> {
  try {
    return await readFile(adminHtmlPath, "utf8");
  } catch {
    return undefined;
  }
}

// Static project info served at GET /. Endpoint strings mirror README's
// "엔드포인트 계약" table; keep both in sync when a route is added or renamed.
const PROJECT_INFO = {
  name: pkg.name,
  version: pkg.version,
  description: "로컬 개발용 NICE 본인인증 API 목 서버 — 토큰 발급 → 표준창 인증 → 암호화 결과 조회",
  repository: "https://github.com/allbegray/nice-id-mock-server",
  docs: "https://github.com/allbegray/nice-id-mock-server#readme",
  endpoints: {
    health: "GET /health",
    token: "POST /ido/intc/v1.0/auth/token",
    authUrl: "POST /ido/intc/v1.0/auth/url",
    authResult: "POST /ido/intc/v1.0/auth/result",
    certRequest: "GET /ido/cert/request/:certId",
    certComplete: "POST /ido/cert/request/:certId/complete",
    certCancel: "POST /ido/cert/request/:certId/cancel",
    adminPage: "GET /admin",
    adminClients: "GET|POST /admin/clients",
    adminClient: "GET|PUT|DELETE /admin/clients/:clientId",
  },
} as const;

export interface BuildAppOptions {
  // Pino destination for structured log lines. Used by tests to capture
  // logs in-memory; production leaves it undefined (stdout).
  logStream?: NodeJS.WritableStream;
}

export function buildApp(
  configOverrides?: Partial<Config>,
  appOptions?: BuildAppOptions,
): FastifyInstance {
  const config = { ...loadConfig(), ...configOverrides };
  // Built once per app: the handler returns this same object every request.
  const projectInfo = {
    ...PROJECT_INFO,
    defaultIdentity: { ...config.defaultIdentity },
  };

  // logLevel=silent disables the logger entirely (tests force this via
  // LOG_LEVEL so tap output stays readable). A caller-supplied stream lets
  // tests capture structured lines without touching stdout.
  const logger =
    config.logLevel === "silent" && appOptions?.logStream === undefined
      ? false
      : {
          level: config.logLevel === "silent" ? "info" : config.logLevel,
          ...(appOptions?.logStream === undefined ? {} : { stream: appOptions.logStream }),
        };

  // Default per-request "incoming request"/"request completed" lines are
  // disabled (LogController, not the deprecated top-level flag); the
  // onResponse hook below emits a single "요청 완료" line that also carries the
  // duration, so each request costs exactly one access line plus the
  // handler's own business line (both share the reqId).
  const app = Fastify({
    bodyLimit: 1048576,
    logger,
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Single access line per request. /health stays at debug: the Docker
  // HEALTHCHECK hits it every 10s and would otherwise drown real traffic.
  app.addHook("onResponse", async (request, reply) => {
    const fields = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 10) / 10,
    };
    if (request.url === "/health" || request.url.startsWith("/health?")) {
      request.log.debug(fields, "요청 완료");
    } else {
      request.log.info(fields, "요청 완료");
    }
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/health", async (_request, _reply) => {
    return { status: "UP" };
  });

  app.get("/", async (_request, _reply) => projectInfo);

  app.register(authTokenRoutes);
  app.register(authUrlRoutes);
  app.register(authResultRoutes);
  app.register(certWindowRoutes);
  app.register(adminRoutes);

  return app;
}
