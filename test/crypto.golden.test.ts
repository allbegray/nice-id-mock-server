import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decryptForTest, encryptResult, kdfValue } from "../src/crypto.ts";

const TICKET = "UzEyMDI1MTExMzA5NTQ0MjI3NDE1Njc3QTM0RDBBRUZEMjI5MzUzQzEz";
const TRANSACTION_ID = "UzE0MUQyNkFDOEQ3NzYyMDIwMjUxMTEzMTAwMjM3MzM4OTQ5QUMwMkU";
const ITERATORS = 66;
const PLAINTEXT_JSON =
  '{"name":"홍길동","birthdate":"19000208","gender":"1","national_info":"0","ci":"CI값","di":"DI값","mobile_co":"2","mobile_no":"01012345678"}';
const FIXED_IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);

interface GoldenVectors {
  kdfValue: string;
  encData: string;
  integrityValue: string;
}

const fixture: GoldenVectors = JSON.parse(
  readFileSync(new URL("./fixtures/golden-vectors.json", import.meta.url), "utf8"),
) as GoldenVectors;

test("kdfValue matches JVM golden vector", () => {
  assert.equal(kdfValue(TICKET, TRANSACTION_ID, ITERATORS), fixture.kdfValue);
});

test("encryptResult with fixed IV matches JVM golden vector byte-for-byte", () => {
  const { encData, integrityValue } = encryptResult(
    PLAINTEXT_JSON,
    { ticket: TICKET, transactionId: TRANSACTION_ID, iterators: ITERATORS },
    FIXED_IV,
  );
  assert.equal(encData, fixture.encData);
  assert.equal(integrityValue, fixture.integrityValue);
});

test("round-trip: random-IV encrypt then decryptForTest returns input", () => {
  const { encData, integrityValue } = encryptResult(PLAINTEXT_JSON, {
    ticket: TICKET,
    transactionId: TRANSACTION_ID,
    iterators: ITERATORS,
  });
  const back = decryptForTest(TICKET, ITERATORS, TRANSACTION_ID, encData, integrityValue);
  assert.equal(back, PLAINTEXT_JSON);
});

test("round-trip: fixed-IV vector decrypts to fixture plaintext", () => {
  const back = decryptForTest(TICKET, ITERATORS, TRANSACTION_ID, fixture.encData, fixture.integrityValue);
  assert.equal(back, PLAINTEXT_JSON);
});

test("decryptForTest throws on tampered integrityValue", () => {
  const last = fixture.integrityValue.slice(-1);
  const flipped = last === "A" ? "B" : "A";
  const tampered = fixture.integrityValue.slice(0, -1) + flipped;
  assert.throws(() => {
    decryptForTest(TICKET, ITERATORS, TRANSACTION_ID, fixture.encData, tampered);
  });
});

test("decryptForTest throws on tampered ciphertext (GCM auth failure)", () => {
  // Flip one ciphertext byte, then re-compute a MATCHING integrity over the
  // tampered encData (via the public kdf-derived hmac key) so the integrity
  // layer passes and the AES-GCM auth tag check is the layer that rejects.
  const raw = Buffer.from(fixture.encData, "base64url");
  raw[20] ^= 0xff;
  const tamperedEnc = raw.toString("base64url");
  const hmacKey = kdfValue(TICKET, TRANSACTION_ID, ITERATORS).slice(48, 80);
  const matchingIntegrity = createHmac("sha256", hmacKey).update(tamperedEnc, "utf8").digest("base64url");
  assert.throws(() => {
    decryptForTest(TICKET, ITERATORS, TRANSACTION_ID, tamperedEnc, matchingIntegrity);
  });
});

test("ASCII guard rejects non-ASCII ticket/transactionId", () => {
  assert.throws(() => {
    kdfValue("티켓", TRANSACTION_ID, ITERATORS);
  });
  assert.throws(() => {
    kdfValue(TICKET, "tx id!", ITERATORS);
  });
  assert.throws(() => {
    encryptResult(PLAINTEXT_JSON, { ticket: TICKET, transactionId: "한글", iterators: ITERATORS });
  });
});
