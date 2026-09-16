import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = buildApp(config);

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`nice-id-mock-server listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
