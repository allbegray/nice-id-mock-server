import { createHash } from "node:crypto";
import type { AuthMethod, Identity } from "./types.ts";

export type { AuthMethod, Identity } from "./types.ts";

// 표준창 인증수단 코드 (svc_types 원소). 결과 필드 구성이 이 값에 따라
// 달라진다: M 휴대폰 → mobile_co/mobile_no, I 아이핀 → ci_update/vnumber/
// age_code/auth_method, F 금융인증서·U 공동인증서 → 공통 필드만.
export const AUTH_METHODS: readonly AuthMethod[] = ["M", "F", "I", "U"];

export function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === "string" && (AUTH_METHODS as readonly string[]).includes(value);
}

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

export interface ValidateIdentityOptions {
  // 휴대폰인증(M)일 때만 통신사·번호가 결과에 실리므로, 아이핀/인증서
  // 경로에서는 검증을 건너뛴다.
  requireMobile?: boolean;
}

// Validate and return the normalized identity. Throws an Error naming the
// offending field when any rule fails.
export function validateIdentity(input: unknown, options: ValidateIdentityOptions = {}): Identity {
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
  if (options.requireMobile ?? true) {
    if (!MOBILE_CO_CODES.includes(normalized.mobileCo)) {
      throw new Error('mobileCo must be one of "1", "2", "3", "5", "6", "7"');
    }
    if (!/^\d{10,11}$/.test(normalized.mobileNo)) {
      throw new Error("mobileNo must be 10-11 digits");
    }
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

// 아이핀 전용 필드. 실 서비스 값은 계약/아이핀 계정에 달려 있으므로 mock은
// 같은 입력에 항상 같은 값이 나오도록 유도한다 (CI/DI와 같은 결정성 규칙).
// vnumber: 프리이미지 sha256 다이제스트에서 십진수 10자리.
// Mock limitation: 값 형식(10자리 숫자)만 실 서비스와 맞춘다.
export function deriveVnumber(identity: Identity): string {
  const digest = createHash("sha256")
    .update(
      `nice-mock-vn|${identity.name}|${identity.birthdate}|${identity.gender}|${identity.nationalInfo}`,
      "utf8",
    )
    .digest();
  let value = "";
  for (const byte of digest) {
    value += String(byte % 10);
    if (value.length === 10) break;
  }
  return value;
}

// 아이핀 전용 age_code. 구간은 가이드 표 그대로:
// 0: 9세미만, 1: 9~12세미만, 2: 12~14세미만, 3: 14~15세미만,
// 4: 15~18세미만, 5: 18~19세미만, 6: 19~20세미만, 7: 20세이상.
// 만 나이(로컬 시간) 기준이라 조회 시점에 따라 값이 달라진다.
const AGE_CODE_LIMITS: readonly (readonly [number, string])[] = [
  [9, "0"],
  [12, "1"],
  [14, "2"],
  [15, "3"],
  [18, "4"],
  [19, "5"],
  [20, "6"],
];

export function deriveAgeCode(birthdate: string, now: Date = new Date()): string {
  const year = Number(birthdate.slice(0, 4));
  const month = Number(birthdate.slice(4, 6));
  const day = Number(birthdate.slice(6, 8));
  const monthNow = now.getMonth() + 1;
  const dayNow = now.getDate();
  const beforeBirthday = monthNow < month || (monthNow === month && dayNow < day);
  const age = now.getFullYear() - year - (beforeBirthday ? 1 : 0);
  for (const [limit, code] of AGE_CODE_LIMITS) {
    if (age < limit) return code;
  }
  return "7";
}

export interface ResultJson {
  name: string;
  birthdate: string;
  gender: string;
  national_info: string;
  ci: string;
  di: string;
  ci_update?: string;
  mobile_co?: string;
  mobile_no?: string;
  vnumber?: string;
  age_code?: string;
  auth_method?: string;
}

// 복호화 후 JSON의 키 집합. 순서는 가이드 결과 표를 따른다.
export const RESULT_JSON_KEYS_BY_METHOD: Record<AuthMethod, readonly string[]> = {
  M: ["name", "birthdate", "gender", "national_info", "ci", "di", "mobile_co", "mobile_no"],
  I: [
    "name",
    "birthdate",
    "gender",
    "national_info",
    "ci",
    "di",
    "ci_update",
    "vnumber",
    "age_code",
    "auth_method",
  ],
  F: ["name", "birthdate", "gender", "national_info", "ci", "di"],
  U: ["name", "birthdate", "gender", "national_info", "ci", "di"],
};

// Emit EXACTLY the snake_case fields of the completed auth method. Nullable
// AuthResultData fields (ci2) are omitted, like the real service omits
// anything not contracted. The identity is validated first so no code
// outside the allowlists is emitted.
export function buildResultJson(
  identity: Identity,
  clientId: string,
  authMethod: AuthMethod,
  now: Date = new Date(),
): ResultJson {
  const valid = validateIdentity(identity, { requireMobile: authMethod === "M" });
  const json: ResultJson = {
    name: valid.name,
    birthdate: valid.birthdate,
    gender: valid.gender,
    national_info: valid.nationalInfo,
    ci: deriveCi(valid),
    di: deriveDi(valid, clientId),
  };
  if (authMethod === "M") {
    json.mobile_co = valid.mobileCo;
    json.mobile_no = valid.mobileNo;
  } else if (authMethod === "I") {
    json.ci_update = "0";
    json.vnumber = deriveVnumber(valid);
    json.age_code = deriveAgeCode(valid.birthdate, now);
    json.auth_method = "5";
  }
  return json;
}
