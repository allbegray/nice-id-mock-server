import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildApp } from "../src/app.ts";
import { createSession, loadByRequestNo, updateSession } from "../src/store.ts";
import { closeTestDb, initTestDb } from "./helpers/testDb.ts";

const REQUEST_NO = "REQ12345678901234567890";
const RETURN_URL = `https://merchant.example.com/nice-id/return?requestNo=${REQUEST_NO}`;
const CLOSE_URL = "https://merchant.example.com/nice-id/close";

function issuePending(
  methodType: string = "GET",
  options: {
    closeUrl?: string;
    expired?: boolean;
    svcTypes?: string[];
    expMods?: string[];
  } = {},
): string {
  createSession(REQUEST_NO);
  const certId = `S${randomUUID()}`;
  updateSession(REQUEST_NO, {
    certId,
    transactionId: randomBytes(42).toString("base64url"),
    returnUrl: RETURN_URL,
    closeUrl: options.closeUrl,
    svcTypes: options.svcTypes ?? ["M"],
    methodType,
    expMods: options.expMods ?? [],
    authUrlExpiresAt: Date.now() + (options.expired === true ? -1000 : 600000),
    status: "PENDING",
  });
  return certId;
}

function validForm(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    name: "홍길동",
    birthdate: "19000208",
    gender: "1",
    national_info: "0",
    mobile_co: "2",
    mobile_no: "01012345678",
    ...overrides,
  }).toString();
}

function validJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "홍길동",
    birthdate: "19000208",
    gender: "1",
    national_info: "0",
    mobile_co: "2",
    mobile_no: "01012345678",
    ...overrides,
  };
}

describe("GET /ido/cert/request/:certId", () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it("page 200 contains request_no and return_url", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({ method: "GET", url: `/ido/cert/request/${certId}` });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers["content-type"] ?? "", /text\/html/);
      assert.ok(response.body.includes(REQUEST_NO), "page must show request_no");
      assert.ok(response.body.includes(RETURN_URL), "page must show return_url");
      assert.ok(response.body.includes("인증 완료"), "page must have a complete button");
    } finally {
      await app.close();
    }
  });

  it("unknown certId -> 404 Korean guidance to re-issue via /auth/url", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ido/cert/request/S00000000-0000-0000-0000-000000000000",
      });
      assert.equal(response.statusCode, 404);
      assert.ok(response.body.includes("다시 발급"), "404 page must guide re-issuance");
      assert.ok(response.body.includes("/auth/url"), "404 page must mention /auth/url");
    } finally {
      await app.close();
    }
  });

  it("expired auth window -> 404", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { expired: true });
      const response = await app.inject({ method: "GET", url: `/ido/cert/request/${certId}` });
      assert.equal(response.statusCode, 404);
      assert.ok(response.body.includes("다시 발급"));
    } finally {
      await app.close();
    }
  });

  it("?auto=1 (GET mode) -> 302 with DEFAULT_IDENTITY and SUCCESS status", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "GET",
        url: `/ido/cert/request/${certId}?auto=1`,
      });
      assert.equal(response.statusCode, 302);
      const location = response.headers.location ?? "";
      const url = new URL(location);
      assert.equal(url.searchParams.get("requestNo"), REQUEST_NO);
      const wtid = url.searchParams.get("web_transaction_id");
      assert.ok(wtid !== null && wtid !== "", "Location must carry web_transaction_id");
      const stored = loadByRequestNo(REQUEST_NO);
      assert.equal(stored?.status, "SUCCESS");
      assert.equal(stored?.webTransactionId, wtid);
      assert.equal(stored?.identity?.name, "홍길동");
    } finally {
      await app.close();
    }
  });

  it("?auto=1 (POST mode) -> 200 auto-submitting form", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("POST");
      const response = await app.inject({
        method: "GET",
        url: `/ido/cert/request/${certId}?auto=1`,
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes(`action="${RETURN_URL}"`));
      assert.ok(response.body.includes('name="web_transaction_id"'));
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "SUCCESS");
    } finally {
      await app.close();
    }
  });

  it("?auto=1&fail=3032 -> session FAILED (explicit fail beats auto)", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "GET",
        url: `/ido/cert/request/${certId}?auto=1&fail=3032`,
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes("3032"));
      const stored = loadByRequestNo(REQUEST_NO);
      assert.equal(stored?.status, "FAILED");
      assert.equal(stored?.failCode, "3032");
      // Assert the session state only — /auth/result belongs to the sibling route.
    } finally {
      await app.close();
    }
  });
});

describe("POST /ido/cert/request/:certId/complete", () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it("GET-mode complete (form-encoded) -> 302 Location with requestNo + web_transaction_id", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: validForm(),
      });
      assert.equal(response.statusCode, 302);
      const location = response.headers.location ?? "";
      const url = new URL(location);
      assert.equal(
        url.searchParams.get("requestNo"),
        REQUEST_NO,
        "existing requestNo query must be preserved",
      );
      const wtid = url.searchParams.get("web_transaction_id");
      assert.ok(wtid !== null && wtid !== "", "Location must carry web_transaction_id");
      const stored = loadByRequestNo(REQUEST_NO);
      assert.equal(stored?.status, "SUCCESS");
      assert.equal(stored?.webTransactionId, wtid);
      assert.equal(stored?.identity?.mobileNo, "01012345678");
    } finally {
      await app.close();
    }
  });

  it("POST-mode complete (JSON) -> 200 body with action + hidden web_transaction_id", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("POST");
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        payload: validJson(),
      });
      assert.equal(response.statusCode, 200);
      assert.ok(
        response.body.includes(`action="${RETURN_URL}"`),
        "auto-submit form must target return_url",
      );
      assert.ok(
        response.body.includes('name="web_transaction_id"'),
        "auto-submit form must carry hidden field",
      );
      assert.ok(response.body.includes("document.forms[0].submit()"));
      const match = /name="web_transaction_id" value="([^"]+)"/.exec(response.body);
      assert.ok(match?.[1] !== undefined && match[1] !== "");
      assert.equal(loadByRequestNo(REQUEST_NO)?.webTransactionId, match?.[1]);
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "SUCCESS");
    } finally {
      await app.close();
    }
  });

  it("invalid identity (mobile_no abc) -> 400 + Korean error, session stays PENDING", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: validForm({ mobile_no: "abc" }),
      });
      assert.equal(response.statusCode, 400);
      assert.ok(
        response.body.includes("입력 정보를 확인해 주세요"),
        "400 page must carry a Korean error message",
      );
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "PENDING");
    } finally {
      await app.close();
    }
  });

  it("fail injection (fail_code=3032) -> FAILED + Korean failure page", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: validForm({ fail_code: "3032" }),
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes("실패"), "failure page must be Korean");
      assert.ok(response.body.includes("3032"));
      const stored = loadByRequestNo(REQUEST_NO);
      assert.equal(stored?.status, "FAILED");
      assert.equal(stored?.failCode, "3032");
    } finally {
      await app.close();
    }
  });

  it("custom fail code (3999) is stored as-is", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        payload: validJson({ fail_code: "custom", fail_code_custom: "3999" }),
      });
      assert.equal(response.statusCode, 200);
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "FAILED");
      assert.equal(loadByRequestNo(REQUEST_NO)?.failCode, "3999");
    } finally {
      await app.close();
    }
  });

  it("non-3xxx fail code is ignored (success path)", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        payload: validJson({ fail_code: "9999" }),
      });
      assert.equal(response.statusCode, 302);
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "SUCCESS");
    } finally {
      await app.close();
    }
  });

  it("unknown certId -> 404", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ido/cert/request/S00000000-0000-0000-0000-000000000000/complete",
        payload: validJson(),
      });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it("아이핀(I) 세션: svc_type=I 로 휴대폰 입력 없이 완료 -> authMethod 저장", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { svcTypes: ["I"] });
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          svc_type: "I",
          name: "홍길동",
          birthdate: "19000208",
          gender: "1",
          national_info: "0",
        }).toString(),
      });
      assert.equal(response.statusCode, 302);
      const stored = loadByRequestNo(REQUEST_NO);
      assert.equal(stored?.status, "SUCCESS");
      assert.equal(stored?.authMethod, "I");
      assert.equal(stored?.identity?.mobileNo, "");
    } finally {
      await app.close();
    }
  });

  it("svc_types 밖의 svc_type -> 400 (허용된 수단만 고를 수 있다)", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { svcTypes: ["M"] });
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/complete`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: validForm({ svc_type: "I" }),
      });
      assert.equal(response.statusCode, 400);
      assert.ok(response.body.includes("인증수단(svc_type)"));
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "PENDING");
    } finally {
      await app.close();
    }
  });

  it("svc_types 목록이 페이지 선택지가 된다 (M+I)", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { svcTypes: ["M", "I"] });
      const response = await app.inject({ method: "GET", url: `/ido/cert/request/${certId}` });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('<option value="M" selected>'), "first type is preselected");
      assert.ok(response.body.includes('<option value="I">'), "all svc_types are selectable");
      assert.equal(response.body.includes('<option value="U">'), false);
    } finally {
      await app.close();
    }
  });

  it("?svc_type=I 로 아이핀을 골라 auto 완료할 수 있다", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { svcTypes: ["M", "I"] });
      const response = await app.inject({
        method: "GET",
        url: `/ido/cert/request/${certId}?auto=1&svc_type=I`,
      });
      assert.equal(response.statusCode, 302);
      assert.equal(loadByRequestNo(REQUEST_NO)?.authMethod, "I");
    } finally {
      await app.close();
    }
  });

  it("exp_mods=closeButtonOn 이면 닫기 버튼을 노출한다", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { expMods: ["closeButtonOn"] });
      const response = await app.inject({ method: "GET", url: `/ido/cert/request/${certId}` });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('form="cancelForm"'), "closeButtonOn must render 닫기");
      assert.ok(response.body.includes("closeButtonOn"), "page must echo exp_mods");
      assert.ok(response.body.includes("인증 완료"));
    } finally {
      await app.close();
    }
  });

  it("exp_mods가 비면 닫기 버튼이 없다 (가이드: 닫기 버튼은 옵션)", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { expMods: [] });
      const response = await app.inject({ method: "GET", url: `/ido/cert/request/${certId}` });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.includes('form="cancelForm"'), false);
      assert.ok(response.body.includes("(없음)"), "page must show exp_mods as empty");
      assert.ok(response.body.includes("인증 완료"));
    } finally {
      await app.close();
    }
  });

  it("unknown certId -> 404", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ido/cert/request/S00000000-0000-0000-0000-000000000000/complete",
        payload: validJson(),
      });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe("POST /ido/cert/request/:certId/cancel", () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it("cancel with close_url -> 302 to close_url + CANCELLED", async () => {
    const app = buildApp();
    try {
      const certId = issuePending("GET", { closeUrl: CLOSE_URL });
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/cancel`,
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, CLOSE_URL);
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "CANCELLED");
    } finally {
      await app.close();
    }
  });

  it("cancel without close_url -> 200 close page with window.close", async () => {
    const app = buildApp();
    try {
      const certId = issuePending();
      const response = await app.inject({
        method: "POST",
        url: `/ido/cert/request/${certId}/cancel`,
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes("window.close()"), "close page must attempt window.close()");
      assert.ok(response.body.includes("취소"), "close page must be Korean");
      assert.equal(loadByRequestNo(REQUEST_NO)?.status, "CANCELLED");
    } finally {
      await app.close();
    }
  });

  it("unknown certId -> 404", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ido/cert/request/S00000000-0000-0000-0000-000000000000/cancel",
      });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe("alias route removal", () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it("GET /cert.html is gone (404)", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/cert.html" });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
