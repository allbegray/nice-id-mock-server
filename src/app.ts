import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import authTokenRoutes from "./routes/authToken.ts";
import authUrlRoutes from "./routes/authUrl.ts";
import authResultRoutes from "./routes/authResult.ts";
import certWindowRoutes from "./routes/certWindow.ts";
import adminRoutes from "./routes/admin.ts";

const certHtmlPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "web",
  "cert.html",
);

export async function readCertHtml(): Promise<string | undefined> {
  try {
    return await readFile(certHtmlPath, "utf8");
  } catch {
    return undefined;
  }
}

const adminHtmlPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "web",
  "admin.html",
);

export async function readAdminHtml(): Promise<string | undefined> {
  try {
    return await readFile(adminHtmlPath, "utf8");
  } catch {
    return undefined;
  }
}

export function buildApp(configOverrides?: Partial<Config>): FastifyInstance {
  const config = { ...loadConfig(), ...configOverrides };
  void config;

  const app = Fastify({ bodyLimit: 1048576 });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (req, body, done) => {
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

  app.register(authTokenRoutes);
  app.register(authUrlRoutes);
  app.register(authResultRoutes);
  app.register(certWindowRoutes);
  app.register(adminRoutes);

  return app;
}
