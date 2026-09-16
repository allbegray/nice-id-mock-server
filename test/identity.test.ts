import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Identity } from "../src/identity.ts";
import {
  buildResultJson,
  deriveCi,
  deriveDi,
  IDENTITY_PRESETS,
  normalizeIdentity,
  RESULT_JSON_KEYS,
  validateIdentity,
} from "../src/identity.ts";

const BASE: Identity = {
  name: "홍길동",
  birthdate: "19000208",
  gender: "1",
  nationalInfo: "0",
  mobileCo: "2",
  mobileNo: "01012345678",
};

// Golden literals pin the new rule so future preimage drift is caught.
// Preimage (verbatim):
//   CI: "nice-mock-ci|홍길동|19000208|1|0"
//   DI: "nice-mock-di|client-a|홍길동|19000208|1|0"
// NOTE: the BASE phone number 01012345678 is IRRELEVANT to CI — changing
// mobileCo/mobileNo must not change CI or DI (see invariance tests below).
const GOLDEN_CI =
  "Hs6ptYpxjAIE_IKE71TNhdNVeeQuto1CP672I50xCgdg3w0hKii11fkLwSjBzFG2SSBGMLiyvwQ_UPacA4BAaA";
const GOLDEN_DI_CLIENT_A =
  "GAYgeTgo96UO9h322mk65vwqyoDAuCKq0DAlYh-XXog_kUQtshLh2xqqe3LX_G0udfGayN8A-PXhXwEOYZotsg";

describe("identity", () => {
  it("CI/DI are deterministic across calls", () => {
    assert.equal(deriveCi(BASE), deriveCi({ ...BASE }));
    assert.equal(deriveDi(BASE, "client-a"), deriveDi({ ...BASE }, "client-a"));
  });

  it("CI/DI are 86-char base64url_nopad and differ from each other", () => {
    const ci = deriveCi(BASE);
    const di = deriveDi(BASE, "client-a");
    assert.match(ci, /^[A-Za-z0-9_-]{86}$/);
    assert.match(di, /^[A-Za-z0-9_-]{86}$/);
    assert.notEqual(ci, di);
  });

  it("CI is invariant to phone/carrier changes", () => {
    const ci = deriveCi(BASE);
    assert.equal(deriveCi({ ...BASE, mobileNo: "01087654321" }), ci);
    assert.equal(deriveCi({ ...BASE, mobileCo: "1" }), ci);
    assert.equal(deriveCi({ ...BASE, mobileCo: "1", mobileNo: "01087654321" }), ci);
  });

  it("CI changes when name/birthdate/gender/nationalInfo changes", () => {
    const ci = deriveCi(BASE);
    assert.notEqual(deriveCi({ ...BASE, name: "김영희" }), ci);
    assert.notEqual(deriveCi({ ...BASE, birthdate: "19000209" }), ci);
    assert.notEqual(deriveCi({ ...BASE, gender: "0" }), ci);
    assert.notEqual(deriveCi({ ...BASE, nationalInfo: "1" }), ci);
  });

  it("DI splits by clientId for the same identity", () => {
    assert.notEqual(deriveDi(BASE, "client-a"), deriveDi(BASE, "client-b"));
  });

  it("DI is invariant to phone/carrier changes under the same clientId", () => {
    const di = deriveDi(BASE, "client-a");
    assert.equal(deriveDi({ ...BASE, mobileNo: "01087654321" }, "client-a"), di);
    assert.equal(deriveDi({ ...BASE, mobileCo: "1" }, "client-a"), di);
  });

  it("golden CI/DI literals pin the preimage rule", () => {
    assert.equal(deriveCi(BASE), GOLDEN_CI);
    assert.equal(deriveDi(BASE, "client-a"), GOLDEN_DI_CLIENT_A);
  });

  it("NFC input normalizes to the same CI as NFC input", () => {
    const nfdName = "홍길동".normalize("NFD");
    assert.notEqual(nfdName, "홍길동");
    const nfdIdentity = normalizeIdentity({ ...BASE, name: nfdName });
    assert.equal(nfdIdentity.name, "홍길동");
    assert.equal(deriveCi(nfdIdentity), deriveCi(BASE));
  });

  it("buildResultJson emits exactly the snake_case key set", () => {
    const json = buildResultJson(BASE, "client-a");
    assert.deepEqual(Object.keys(json), [...RESULT_JSON_KEYS]);
    assert.deepEqual([...Object.keys(json)].sort(), [
      "birthdate",
      "ci",
      "di",
      "gender",
      "mobile_co",
      "mobile_no",
      "name",
      "national_info",
    ]);
    assert.equal(json.name, "홍길동");
    assert.equal(json.birthdate, "19000208");
    assert.equal(json.gender, "1");
    assert.equal(json.national_info, "0");
    assert.equal(json.mobile_co, "2");
    assert.equal(json.mobile_no, "01012345678");
    assert.match(json.ci, /^[A-Za-z0-9_-]{86}$/);
    assert.match(json.di, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(json.ci, deriveCi(BASE));
    assert.equal(json.di, deriveDi(BASE, "client-a"));
    assert.equal(JSON.stringify(json).includes("nationalInfo"), false);
  });

  it("birthdate is a yyyyMMdd string, never ISO", () => {
    const json = buildResultJson(BASE, "client-a");
    assert.match(json.birthdate, /^\d{8}$/);
    assert.equal(json.birthdate.includes("-"), false);
  });

  it("all presets validate and cover the four required personas", () => {
    assert.deepEqual(Object.keys(IDENTITY_PRESETS).sort(), [
      "미성년",
      "성인남성",
      "성인여성",
      "외국인",
    ]);
    assert.deepEqual(validateIdentity(IDENTITY_PRESETS["성인남성"]), {
      name: "홍길동",
      birthdate: "19000208",
      gender: "1",
      nationalInfo: "0",
      mobileCo: "2",
      mobileNo: "01012345678",
    });
    assert.equal(validateIdentity(IDENTITY_PRESETS["성인여성"]).gender, "0");
    assert.equal(validateIdentity(IDENTITY_PRESETS["미성년"]).birthdate, "20150101");
    assert.equal(validateIdentity(IDENTITY_PRESETS["외국인"]).nationalInfo, "1");
  });

  it("normalizeIdentity trims and accepts snake_case keys", () => {
    assert.deepEqual(
      normalizeIdentity({
        name: "  홍길동 ",
        birthdate: "19000208",
        gender: "1",
        national_info: "0",
        mobile_co: "2",
        mobile_no: "01012345678",
      }),
      BASE,
    );
  });

  it("rejects blank names", () => {
    assert.throws(() => validateIdentity({ ...BASE, name: "   " }), /name must not be blank/);
  });

  it("rejects malformed birthdates", () => {
    assert.throws(() => validateIdentity({ ...BASE, birthdate: "1900208" }), /birthdate/);
    assert.throws(() => validateIdentity({ ...BASE, birthdate: "1900020a" }), /birthdate/);
  });

  it("rejects impossible calendar dates but allows leap days", () => {
    assert.throws(
      () => validateIdentity({ ...BASE, birthdate: "20230229" }),
      /not a real calendar date/,
    );
    assert.throws(
      () => validateIdentity({ ...BASE, birthdate: "20231301" }),
      /not a real calendar date/,
    );
    assert.equal(validateIdentity({ ...BASE, birthdate: "20200229" }).birthdate, "20200229");
  });

  it("rejects codes outside the allowlists, never mobile_co 4", () => {
    assert.throws(() => validateIdentity({ ...BASE, gender: "2" }), /gender/);
    assert.throws(() => validateIdentity({ ...BASE, nationalInfo: "2" }), /nationalInfo/);
    assert.throws(() => validateIdentity({ ...BASE, mobileCo: "4" }), /mobileCo/);
    assert.throws(() => validateIdentity({ ...BASE, mobileCo: "8" }), /mobileCo/);
  });

  it("rejects malformed mobile numbers", () => {
    assert.throws(() => validateIdentity({ ...BASE, mobileNo: "12" }), /mobileNo/);
    assert.throws(() => validateIdentity({ ...BASE, mobileNo: "010-1234-5678" }), /mobileNo/);
    assert.throws(() => validateIdentity({ ...BASE, mobileNo: "010123456789" }), /mobileNo/);
  });

  it("rejects non-object input", () => {
    assert.throws(() => validateIdentity(undefined), /must be an object/);
    assert.throws(() => validateIdentity("홍길동"), /must be an object/);
  });
});
