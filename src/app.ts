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

const certHtmlPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "web",
  "cert.html",
);

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

  app.get("/cert.html", async (_request, reply) => {
    try {
      const html = await readFile(certHtmlPath, "utf8");
      return reply.type("text/html; charset=utf-8").send(html);
    } catch {
      return reply.code(404).send({ statusCode: 404, error: "Not Found" });
    }
  });

  app.register(authTokenRoutes);
  app.register(authUrlRoutes);
  app.register(authResultRoutes);
  app.register(certWindowRoutes);

  return app;
}
