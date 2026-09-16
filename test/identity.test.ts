import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildResultJson,
  deriveCi,
  deriveDi,
  IDENTITY_PRESETS,
  normalizeIdentity,
  RESULT_JSON_KEYS,
  validateIdentity,
} from "../src/identity.ts";
import type { Identity } from "../src/identity.ts";

const BASE: Identity = {
  name: "홍길동",
  birthdate: "19000208",
  gender: "1",
  nationalInfo: "0",
  mobileCo: "2",
  mobileNo: "01012345678",
};

describe("identity", () => {
  it("CI/DI are deterministic across calls", () => {
    assert.equal(deriveCi(BASE), deriveCi({ ...BASE }));
    assert.equal(deriveDi(BASE), deriveDi({ ...BASE }));
  });

  it("CI/DI are 86-char base64url_nopad and differ from each other", () => {
    const ci = deriveCi(BASE);
    const di = deriveDi(BASE);
    assert.match(ci, /^[A-Za-z0-9_-]{86}$/);
    assert.match(di, /^[A-Za-z0-9_-]{86}$/);
    assert.notEqual(ci, di);
  });

  it("CI changes when any preimage field changes", () => {
    const other = deriveCi({ ...BASE, mobileNo: "01087654321" });
    assert.notEqual(deriveCi(BASE), other);
  });

  it("buildResultJson emits exactly the snake_case key set", () => {
    const json = buildResultJson(BASE);
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
    assert.equal(JSON.stringify(json).includes("nationalInfo"), false);
  });

  it("birthdate is a yyyyMMdd string, never ISO", () => {
    const json = buildResultJson(BASE);
    assert.match(json.birthdate, /^\d{8}$/);
    assert.equal(json.birthdate.includes("-"), false);
  });

  it("all presets validate and cover the four required personas", () => {
    assert.deepEqual(Object.keys(IDENTITY_PRESETS).sort(), ["미성년", "성인남성", "성인여성", "외국인"]);
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
