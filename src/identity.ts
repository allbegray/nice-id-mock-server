import { createHash } from "node:crypto";
import type { Identity } from "./types.ts";

export type { Identity } from "./types.ts";

// Allowlist mirrors the client enums: Gender.kt (0/1), National.kt (0/1),
// MobileCo.kt (1/2/3/5/6/7 — NEVER 4). The client's `of()` throws
// NoSuchElementException on unknown codes, so validation must reject
// anything outside these sets before it is ever emitted.
export const GENDER_CODES: readonly string[] = ["0", "1"];
export const NATIONAL_CODES: readonly string[] = ["0", "1"];
export const MOBILE_CO_CODES: readonly string[] = ["1", "2", "3", "5", "6", "7"];

// Accepts both camelCase (internal) and snake_case (form/API) keys so the
// 표준창 route can pass request fields straight through.
export interface IdentityLike {
  name?: unknown;
  birthdate?: unknown;
  gender?: unknown;
  nationalInfo?: unknown;
  national_info?: unknown;
  mobileCo?: unknown;
  mobile_co?: unknown;
  mobileNo?: unknown;
  mobile_no?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickString(first: unknown, second: unknown): string | undefined {
  return asString(first) ?? asString(second);
}

function isRealCalendarDate(yyyymmdd: string): boolean {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const dim = daysInMonth[month - 1];
  if (dim === undefined) return false;
  return day >= 1 && day <= dim;
}

// Trim whitespace without validating. Used by the form layer to clean
// input before validation.
export function normalizeIdentity(input: IdentityLike): Identity {
  const national = pickString(input.nationalInfo, input.national_info);
  const mobileCo = pickString(input.mobileCo, input.mobile_co);
  const mobileNo = pickString(input.mobileNo, input.mobile_no);
  return {
    name: asString(input.name)?.trim().normalize("NFC") ?? "",
    birthdate: asString(input.birthdate)?.trim() ?? "",
    gender: asString(input.gender)?.trim() ?? "",
    nationalInfo: national?.trim() ?? "",
    mobileCo: mobileCo?.trim() ?? "",
    mobileNo: mobileNo?.trim() ?? "",
  };
}

// Validate and return the normalized identity. Throws an Error naming the
// offending field when any rule fails.
export function validateIdentity(input: unknown): Identity {
  if (typeof input !== "object" || input === null) {
    throw new Error("identity must be an object");
  }
  const normalized = normalizeIdentity(input as IdentityLike);

  if (normalized.name === "") {
    throw new Error("name must not be blank");
  }
  if (!/^\d{8}$/.test(normalized.birthdate)) {
    throw new Error("birthdate must be yyyyMMdd (8 digits)");
  }
  if (!isRealCalendarDate(normalized.birthdate)) {
    throw new Error("birthdate is not a real calendar date");
  }
  if (!GENDER_CODES.includes(normalized.gender)) {
    throw new Error('gender must be "0" or "1"');
  }
  if (!NATIONAL_CODES.includes(normalized.nationalInfo)) {
    throw new Error('nationalInfo must be "0" or "1"');
  }
  if (!MOBILE_CO_CODES.includes(normalized.mobileCo)) {
    throw new Error('mobileCo must be one of "1", "2", "3", "5", "6", "7"');
  }
  if (!/^\d{10,11}$/.test(normalized.mobileNo)) {
    throw new Error("mobileNo must be 10-11 digits");
  }
  return normalized;
}

export const PRESET_ADULT_MALE: Identity = {
  name: "홍길동",
  birthdate: "19000208",
  gender: "1",
  nationalInfo: "0",
  mobileCo: "2",
  mobileNo: "01012345678",
};

export const PRESET_ADULT_FEMALE: Identity = {
  name: "김영희",
  birthdate: "19900515",
  gender: "0",
  nationalInfo: "0",
  mobileCo: "1",
  mobileNo: "01087654321",
};

export const PRESET_MINOR: Identity = {
  name: "박민준",
  birthdate: "20150101",
  gender: "1",
  nationalInfo: "0",
  mobileCo: "3",
  mobileNo: "01011112222",
};

export const PRESET_FOREIGNER: Identity = {
  name: "Alex Kim",
  birthdate: "19881123",
  gender: "1",
  nationalInfo: "1",
  mobileCo: "2",
  mobileNo: "01033334444",
};

export type PresetName = "성인남성" | "성인여성" | "미성년" | "외국인";

export const IDENTITY_PRESETS: Record<PresetName, Identity> = {
  성인남성: PRESET_ADULT_MALE,
  성인여성: PRESET_ADULT_FEMALE,
  미성년: PRESET_MINOR,
  외국인: PRESET_FOREIGNER,
};

function digestBase64UrlNoPad(preimage: string): string {
  return createHash("sha512").update(preimage, "utf8").digest("base64url");
}

// Deterministic CI/DI: sha512 over the EXACT preimage template, encoded
// base64url without padding (64 bytes -> 86 chars).
// CI binds name+birthdate+gender+nationalInfo only (phone/carrier EXCLUDED
// so a number change keeps CI stable). DI binds the same fields plus the
// clientId as the SECOND preimage segment (client-scoped). The `nice-mock-`
// prefix IS the version marker — no extra salt/version suffix.
// Mock limitation: a `|` inside `name` is accepted as-is (no escaping).
export function deriveCi(identity: Identity): string {
  const preimage = `nice-mock-ci|${identity.name}|${identity.birthdate}|${identity.gender}|${identity.nationalInfo}`;
  return digestBase64UrlNoPad(preimage);
}

export function deriveDi(identity: Identity, clientId: string): string {
  const preimage = `nice-mock-di|${clientId}|${identity.name}|${identity.birthdate}|${identity.gender}|${identity.nationalInfo}`;
  return digestBase64UrlNoPad(preimage);
}

export interface ResultJson {
  name: string;
  birthdate: string;
  gender: string;
  national_info: string;
  ci: string;
  di: string;
  mobile_co: string;
  mobile_no: string;
}

export const RESULT_JSON_KEYS: readonly string[] = [
  "name",
  "birthdate",
  "gender",
  "national_info",
  "ci",
  "di",
  "mobile_co",
  "mobile_no",
];

// Emit EXACTLY the snake_case result fields. Nullable AuthResultData fields
// (ci2, ci_update, vnumber, age_code, auth_method) are omitted. The
// identity is validated first so no code outside the allowlists is emitted.
export function buildResultJson(identity: Identity, clientId: string): ResultJson {
  const valid = validateIdentity(identity);
  return {
    name: valid.name,
    birthdate: valid.birthdate,
    gender: valid.gender,
    national_info: valid.nationalInfo,
    ci: deriveCi(valid),
    di: deriveDi(valid, clientId),
    mobile_co: valid.mobileCo,
    mobile_no: valid.mobileNo,
  };
}
