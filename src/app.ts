import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
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

export function buildApp(configOverrides?: Partial<Config>): FastifyInstance {
  const config = { ...loadConfig(), ...configOverrides };
  // Built once per app: the handler returns this same object every request.
  const projectInfo = {
    ...PROJECT_INFO,
    defaultIdentity: { ...config.defaultIdentity },
  };

  const app = Fastify({ bodyLimit: 1048576 });

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
