export interface Identity {
  name: string;
  birthdate: string;
  gender: string;
  nationalInfo: string;
  mobileCo: string;
  mobileNo: string;
}

export type SessionStatus = "CREATED" | "PENDING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface Session {
  requestNo: string;
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
  status: SessionStatus;
  identity?: Identity;
  webTransactionId?: string;
  failCode?: string;
  resultFetchedAt?: number;
}
