import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const ASCII_PATTERN = /^[A-Za-z0-9_-]+$/;
const GCM_IV_BYTES = 16;
const GCM_TAG_BYTES = 16;

export interface NiceCredentials {
  ticket: string;
  transactionId: string;
  iterators: number;
}

export interface EncryptedResult {
  encData: string;
  integrityValue: string;
}

function assertAsciiSafe(ticket: string, transactionId: string): void {
  if (!ASCII_PATTERN.test(ticket) || !ASCII_PATTERN.test(transactionId)) {
    throw new Error("ticket and transactionId must match ^[A-Za-z0-9_-]+$");
  }
}

export function kdfValue(ticket: string, transactionId: string, iterators: number): string {
  assertAsciiSafe(ticket, transactionId);
  return pbkdf2Sync(Buffer.from(ticket, "utf8"), Buffer.from(transactionId, "utf8"), iterators, 64, "sha256").toString(
    "base64url",
  );
}

export function encryptResult(json: string, creds: NiceCredentials, iv?: Buffer): EncryptedResult {
  assertAsciiSafe(creds.ticket, creds.transactionId);
  const keyString = kdfValue(creds.ticket, creds.transactionId, creds.iterators);
  const aesKey = Buffer.from(keyString.slice(0, 32), "utf8");
  const hmacKey = keyString.slice(48, 80);
  const ivBytes: Buffer = iv ?? randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", aesKey, ivBytes);
  const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const encData = Buffer.concat([ivBytes, ciphertext, cipher.getAuthTag()]).toString("base64url");
  const integrityValue = createHmac("sha256", hmacKey).update(encData, "utf8").digest("base64url");
  return { encData, integrityValue };
}

export function decryptForTest(
  ticket: string,
  iterators: number,
  transactionId: string,
  encData: string,
  integrityValue: string,
): string {
  assertAsciiSafe(ticket, transactionId);
  const keyString = kdfValue(ticket, transactionId, iterators);
  const hmacKey = keyString.slice(48, 80);
  const expectedIntegrity = createHmac("sha256", hmacKey).update(encData, "utf8").digest("base64url");
  if (expectedIntegrity !== integrityValue) {
    throw new Error("모듈 내 위변조 데이터 검증에 실패했습니다.");
  }
  const raw = Buffer.from(encData, "base64url");
  const iv = raw.subarray(0, GCM_IV_BYTES);
  const ciphertextAndTag = raw.subarray(GCM_IV_BYTES);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - GCM_TAG_BYTES);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyString.slice(0, 32), "utf8"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
