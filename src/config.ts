import type { Identity } from "./types.ts";

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
  clientId: string;
  clientSecret: string;
  strictCredentials: boolean;
  tokenTtlMs: number;
  authUrlTtlMs: number;
  iterators: number;
  strictOneTimeResult: boolean;
  // SQLite file path. Relative paths resolve against process cwd.
  // ":memory:" selects an ephemeral in-memory database.
  dbPath: string;
  defaultIdentity: Identity;
}

function parseNumberEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected an integer number`);
  }
  return value;
}

function parseBoolEnv(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a boolean (true/false)`);
}

function parseStringEnv(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseNumberEnv("PORT", env["PORT"], 8899),
    host: parseStringEnv(env["HOST"], "0.0.0.0"),
    publicBaseUrl: parseStringEnv(env["PUBLIC_BASE_URL"], "http://localhost:8899"),
    // 최초 시드 값(런타임 고정 아님): first-boot seed only; runtime auth reads the DB.
    clientId: parseStringEnv(env["CLIENT_ID"], "test-client-id"),
    // 최초 시드 값(런타임 고정 아님): first-boot seed only; runtime auth reads the DB.
    clientSecret: parseStringEnv(env["CLIENT_SECRET"], "test-client-secret"),
    strictCredentials: parseBoolEnv("STRICT_CREDENTIALS", env["STRICT_CREDENTIALS"], true),
    tokenTtlMs: parseNumberEnv("TOKEN_TTL_MS", env["TOKEN_TTL_MS"], 86400000),
    authUrlTtlMs: parseNumberEnv("AUTH_URL_TTL_MS", env["AUTH_URL_TTL_MS"], 600000),
    iterators: parseNumberEnv("ITERATORS", env["ITERATORS"], 66),
    strictOneTimeResult: parseBoolEnv(
      "STRICT_ONE_TIME_RESULT",
      env["STRICT_ONE_TIME_RESULT"],
      false,
    ),
    // Relative paths resolve against process cwd. ":memory:" = ephemeral DB.
    dbPath: parseStringEnv(env["DB_PATH"], "data/niceid.db"),
    defaultIdentity: {
      name: "홍길동",
      birthdate: "19000208",
      gender: "1",
      nationalInfo: "0",
      mobileCo: "2",
      mobileNo: "01012345678",
    },
  };
}
