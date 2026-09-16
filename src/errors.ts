import type { FastifyReply } from "fastify";

// Error catalog for the NICE mock server.
// The mock emits EXACTLY these 12 codes — no others.
// Messages are copied from ResultCode.kt; the HTTP status follows that
// file's own `status` field (1xxx -> 400 except 1014 -> 500; 2xxx -> 500;
// 3xxx -> 200).

export type ErrorCode =
  | "1001"
  | "1002"
  | "1003"
  | "1004"
  | "1006"
  | "1014"
  | "2001"
  | "3001"
  | "3011"
  | "3029"
  | "3032"
  | "3033";

export interface ErrorEntry {
  code: ErrorCode;
  status: number;
  message: string;
}

export const ERROR_TABLE: Record<ErrorCode, ErrorEntry> = {
  "1001": { code: "1001", status: 400, message: "Authorization header 오류" },
  "1002": { code: "1002", status: 400, message: "파라미터 유효성 오류" },
  "1003": { code: "1003", status: 400, message: "접근 토큰 만료 오류" },
  "1004": { code: "1004", status: 400, message: "유효한 접근 토큰 아님" },
  "1006": { code: "1006", status: 400, message: "ClientID 권한 없음" },
  "1014": { code: "1014", status: 500, message: "내부 데이터 처리중 오류" },
  "2001": { code: "2001", status: 500, message: "내부 서버 처리중 오류" },
  "3001": { code: "3001", status: 200, message: "JSON 형식의 메시지가 아님" },
  "3011": { code: "3011", status: 200, message: "내부 로직 처리 오류" },
  "3029": { code: "3029", status: 200, message: "요청한 정보를 찾을 수 없음" },
  "3032": { code: "3032", status: 200, message: "인증 성공건이 아니거나 유효시간 초과" },
  "3033": { code: "3033", status: 200, message: "기 인증결과 제공 건" },
};

export const ERROR_CODES: readonly ErrorCode[] = Object.keys(ERROR_TABLE).sort() as ErrorCode[];

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_TABLE, code);
}

export interface ErrorBody {
  result_code: ErrorCode;
  result_message: string;
}

export function errorBody(code: ErrorCode): ErrorBody {
  const entry = ERROR_TABLE[code];
  return { result_code: entry.code, result_message: entry.message };
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_TABLE[code].status;
}

export function sendError(reply: FastifyReply, code: ErrorCode): FastifyReply {
  return reply.code(ERROR_TABLE[code].status).send(errorBody(code));
}
