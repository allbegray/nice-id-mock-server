export interface Identity {
  name: string;
  birthdate: string;
  gender: string;
  nationalInfo: string;
  mobileCo: string;
  mobileNo: string;
}

// 인증수단 코드 = /auth/url 의 svc_types 원소. 결과 필드 구성이 이 값에
// 따라 달라진다 (M: mobile_co/mobile_no, I: ci_update/vnumber/age_code/
// auth_method, F/U: 공통 필드만).
export type AuthMethod = "M" | "F" | "I" | "U";

export type SessionStatus = "CREATED" | "PENDING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface Session {
  requestNo: string;
  clientId: string;
  accessToken: string;
  tokenExpiresAt: number;
  ticket: string;
  iterators: number;
  createdAt: number;
  certId?: string;
  transactionId?: string;
  authUrlExpiresAt?: number;
  returnUrl?: string;
  closeUrl?: string;
  svcTypes?: string[];
  methodType?: string;
  expMods?: string[];
  // 표준창에서 실제로 완료한 인증수단 (svc_types 부분집합).
  authMethod?: AuthMethod;
  status: SessionStatus;
  identity?: Identity;
  webTransactionId?: string;
  failCode?: string;
  resultFetchedAt?: number;
}

export interface Client {
  clientId: string;
  clientSecret: string;
  createdAt: number;
  updatedAt: number;
}
