import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readCertHtml } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { IdentityLike } from "../identity.ts";
import { isAuthMethod, normalizeIdentity, validateIdentity } from "../identity.ts";
import { isAuthWindowExpired, loadByCertId, updateSession } from "../store.ts";
import type { AuthMethod, Identity, Session } from "../types.ts";

const FAIL_CODE_PATTERN = /^3\d{3}$/;

const METHOD_LABELS: Record<AuthMethod, string> = {
  M: "휴대폰 본인확인 (M)",
  F: "금융인증서 (F)",
  U: "공동인증서 (U)",
  I: "아이핀 (I)",
};

// 표준창은 /auth/url 이 지정한 svc_types 안에서만 인증수단을 고를 수 있다.
function allowedMethods(session: Session): AuthMethod[] {
  return (session.svcTypes ?? []).filter(isAuthMethod);
}

function methodSelectHtml(methods: AuthMethod[], current: AuthMethod | undefined): string {
  return methods
    .map((method) => {
      const isSelected = method === current ? " selected" : "";
      return `<option value="${method}"${isSelected}>${METHOD_LABELS[method]}</option>`;
    })
    .join("");
}

interface CompleteBody extends IdentityLike {
  svc_type?: unknown;
  fail_code?: unknown;
  fail_code_custom?: unknown;
}

interface FormValues {
  method: string;
  name: string;
  birthdate: string;
  gender: string;
  nationalInfo: string;
  mobileCo: string;
  mobileNo: string;
  failCode: string;
  failCustom: string;
}

function defaultFormValues(): FormValues {
  return {
    method: "",
    name: "",
    birthdate: "19000208",
    gender: "1",
    nationalInfo: "0",
    mobileCo: "1",
    mobileNo: "",
    failCode: "",
    failCustom: "",
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function selected(current: string, expected: string): string {
  return current === expected ? "selected" : "";
}

function certIdOf(request: FastifyRequest): string {
  const params = request.params as { certId?: unknown };
  return typeof params.certId === "string" ? params.certId : "";
}

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query = request.query as Record<string, unknown> | undefined;
  return query ?? {};
}

function bodyOf(request: FastifyRequest): CompleteBody {
  const body = request.body as CompleteBody | undefined;
  return body ?? {};
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Explicit `fail=` (query param or form field) ALWAYS wins: it beats
// `auto=1` on the page route and beats form validation on complete.
// Only 3xxx codes are honored; anything else is ignored (success path).
function extractFailCode(body: CompleteBody, query: Record<string, unknown>): string {
  const custom = asTrimmed(body.fail_code_custom);
  if (custom !== "") return custom;
  const field = asTrimmed(body.fail_code);
  if (field !== "" && field !== "custom") return field;
  return asTrimmed(query["fail"]);
}

function isFailCode(value: string): boolean {
  return FAIL_CODE_PATTERN.test(value);
}

type MethodResolution =
  | { method: AuthMethod; error?: undefined }
  | { method?: undefined; error: string };

// 요청한 인증수단이 없으면 svc_types의 첫 값이 기본, 목록 밖의 값이면 오류.
function resolveMethod(session: Session, requested: unknown): MethodResolution {
  const methods = allowedMethods(session);
  const fallback = methods[0];
  if (requested === undefined || requested === null || requested === "") {
    return fallback === undefined ? { error: "허용된 인증수단이 없습니다" } : { method: fallback };
  }
  if (isAuthMethod(requested) && methods.includes(requested)) {
    return { method: requested };
  }
  return { error: `인증수단(svc_type) 값이 올바르지 않습니다: ${String(requested)}` };
}

function notFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>인증창을 찾을 수 없음</title></head>
<body>
<h1>인증 요청을 찾을 수 없습니다</h1>
<p>인증 유효시간이 만료되었거나 존재하지 않는 인증창입니다.</p>
<p>POST /ido/intc/v1.0/auth/url 로 인증 URL을 다시 발급받아 접속해 주세요.</p>
</body>
</html>`;
}

function failurePage(session: Session, failCode: string): string {
  const closePart =
    session.closeUrl !== undefined && session.closeUrl !== ""
      ? `<p><a href="${escapeHtml(session.closeUrl)}"><button type="button">닫기</button></a></p>`
      : `<p>창을 닫고 처음부터 다시 시도해 주세요.</p>`;
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>본인인증 실패</title></head>
<body>
<h1>본인인증에 실패했습니다</h1>
<p>실패 코드: ${escapeHtml(failCode)}</p>
${closePart}
</body>
</html>`;
}

function closePage(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>인증 취소</title></head>
<body>
<h1>인증을 취소했습니다</h1>
<p>이 창을 닫아 주세요.</p>
<button type="button" onclick="window.close()">창 닫기</button>
<script>window.close();</script>
</body>
</html>`;
}

function postDeliverPage(returnUrl: string, webTransactionId: string): string {
  const action = escapeHtml(returnUrl);
  const wtid = escapeHtml(webTransactionId);
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>인증 완료 — 이동 중</title></head>
<body>
<p>인증을 완료했습니다. 자동으로 이동합니다…</p>
<form method="POST" action="${action}"><input type="hidden" name="web_transaction_id" value="${wtid}"/></form><script>document.forms[0].submit()</script>
</body>
</html>`;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{[A-Z_0-9]+\}\}/g, (token) => vars[token] ?? token);
}

function formVars(
  session: Session,
  values: FormValues,
  errorMessage?: string,
): Record<string, string> {
  const errorBox =
    errorMessage === undefined || errorMessage === ""
      ? ""
      : `<div class="error" role="alert"><strong>입력 정보를 확인해 주세요.</strong><br>${escapeHtml(errorMessage)}</div>`;
  const methods = allowedMethods(session);
  const requested = isAuthMethod(values.method) ? values.method : undefined;
  const closeButtonOn = (session.expMods ?? []).includes("closeButtonOn");
  return {
    "{{METHOD_OPTIONS}}": methodSelectHtml(methods, requested ?? methods[0]),
    "{{EXP_MODS_DISPLAY}}": escapeHtml((session.expMods ?? []).join(", ") || "(없음)"),
    // 가이드: 표준창 닫기 버튼은 exp_mods=closeButtonOn 일 때만 노출된다.
    "{{CLOSE_BUTTON}}": closeButtonOn
      ? `<button type="submit" class="secondary" form="cancelForm">닫기</button>`
      : "",
    "{{CERT_ID}}": escapeHtml(session.certId ?? ""),
    "{{REQUEST_NO}}": escapeHtml(session.requestNo),
    "{{SVC_TYPES}}": escapeHtml((session.svcTypes ?? []).join(",")),
    "{{METHOD_TYPE}}": escapeHtml(session.methodType ?? "GET"),
    "{{RETURN_URL}}": escapeHtml(session.returnUrl ?? ""),
    "{{CLOSE_URL_DISPLAY}}": escapeHtml(session.closeUrl ?? "(없음)"),
    "{{TTL_SECONDS}}": String(
      session.authUrlExpiresAt === undefined
        ? 0
        : Math.max(0, Math.floor((session.authUrlExpiresAt - Date.now()) / 1000)),
    ),
    "{{EXPIRES_AT}}": String(session.authUrlExpiresAt ?? 0),
    "{{ERROR_BOX}}": errorBox,
    "{{NAME}}": escapeHtml(values.name),
    "{{BIRTHDATE}}": escapeHtml(values.birthdate),
    "{{MOBILE_NO}}": escapeHtml(values.mobileNo),
    "{{SEL_GENDER_0}}": selected(values.gender, "0"),
    "{{SEL_GENDER_1}}": selected(values.gender, "1"),
    "{{SEL_NATIONAL_0}}": selected(values.nationalInfo, "0"),
    "{{SEL_NATIONAL_1}}": selected(values.nationalInfo, "1"),
    "{{SEL_MOBILE_1}}": selected(values.mobileCo, "1"),
    "{{SEL_MOBILE_2}}": selected(values.mobileCo, "2"),
    "{{SEL_MOBILE_3}}": selected(values.mobileCo, "3"),
    "{{SEL_MOBILE_5}}": selected(values.mobileCo, "5"),
    "{{SEL_MOBILE_6}}": selected(values.mobileCo, "6"),
    "{{SEL_MOBILE_7}}": selected(values.mobileCo, "7"),
    "{{SEL_FAIL_NONE}}": selected(values.failCode, ""),
    "{{SEL_FAIL_3032}}": selected(values.failCode, "3032"),
    "{{SEL_FAIL_3029}}": selected(values.failCode, "3029"),
    "{{SEL_FAIL_CUSTOM}}": selected(values.failCode, "custom"),
    "{{FAIL_CUSTOM}}": escapeHtml(values.failCustom),
  };
}

async function renderFormHtml(
  session: Session,
  values: FormValues,
  errorMessage?: string,
): Promise<string | undefined> {
  const template = await readCertHtml();
  if (template === undefined) return undefined;
  return renderTemplate(template, formVars(session, values, errorMessage));
}

async function sendForm(
  reply: FastifyReply,
  session: Session,
  values: FormValues,
  errorMessage?: string,
  statusCode = 200,
): Promise<FastifyReply> {
  const html = await renderFormHtml(session, values, errorMessage);
  if (html === undefined) {
    const detail = errorMessage === undefined ? "" : `: ${escapeHtml(errorMessage)}`;
    return reply
      .code(500)
      .type("text/html; charset=utf-8")
      .send(`<h1>표준창 템플릿을 찾을 수 없습니다${detail}</h1>`);
  }
  return reply.code(statusCode).type("text/html; charset=utf-8").send(html);
}

function newWebTransactionId(): string {
  return Buffer.from(randomUUID(), "utf8").toString("base64url");
}

// Deliver per methodType: GET → 302 with query-merged web_transaction_id
// (existing return_url params such as requestNo are preserved by URL);
// POST → 200 auto-submitting form carrying the hidden field.
async function deliverSuccess(reply: FastifyReply, session: Session): Promise<FastifyReply> {
  const returnUrl = session.returnUrl ?? "";
  const webTransactionId = session.webTransactionId ?? "";
  if (session.methodType === "POST") {
    return reply
      .type("text/html; charset=utf-8")
      .send(postDeliverPage(returnUrl, webTransactionId));
  }
  const url = new URL(returnUrl);
  url.searchParams.append("web_transaction_id", webTransactionId);
  return reply.redirect(url.toString());
}

function resolveSession(certId: string): Session | undefined {
  const session = loadByCertId(certId);
  if (session === undefined || isAuthWindowExpired(session)) return undefined;
  return session;
}

export default async function routes(app: FastifyInstance): Promise<void> {
  app.get("/ido/cert/request/:certId", async (request, reply) => {
    const session = resolveSession(certIdOf(request));
    if (session === undefined) {
      return reply.code(404).type("text/html; charset=utf-8").send(notFoundPage());
    }
    const query = queryOf(request);

    const failCode = extractFailCode({}, query);
    if (failCode !== "" && isFailCode(failCode)) {
      const updated = updateSession(session.requestNo, { status: "FAILED", failCode });
      return reply.type("text/html; charset=utf-8").send(failurePage(updated ?? session, failCode));
    }

    const resolved = resolveMethod(session, query["svc_type"]);
    if (resolved.error !== undefined) {
      return sendForm(
        reply,
        session,
        { ...defaultFormValues(), method: asTrimmed(query["svc_type"]) },
        resolved.error,
        400,
      );
    }
    const method = resolved.method;

    if (query["auto"] === "1") {
      const defaultIdentity: Identity = { ...loadConfig().defaultIdentity };
      const updated = updateSession(session.requestNo, {
        status: "SUCCESS",
        identity: defaultIdentity,
        authMethod: method,
        webTransactionId: newWebTransactionId(),
        failCode: undefined,
      });
      if (updated === undefined) {
        return reply.code(404).type("text/html; charset=utf-8").send(notFoundPage());
      }
      return deliverSuccess(reply, updated);
    }

    return sendForm(reply, session, { ...defaultFormValues(), method });
  });

  app.post("/ido/cert/request/:certId/complete", async (request, reply) => {
    const session = resolveSession(certIdOf(request));
    if (session === undefined) {
      return reply.code(404).type("text/html; charset=utf-8").send(notFoundPage());
    }
    const body = bodyOf(request);
    const query = queryOf(request);

    const failCode = extractFailCode(body, query);
    if (failCode !== "" && isFailCode(failCode)) {
      const updated = updateSession(session.requestNo, { status: "FAILED", failCode });
      return reply.type("text/html; charset=utf-8").send(failurePage(updated ?? session, failCode));
    }

    let identity: Identity;
    const resolved = resolveMethod(session, body.svc_type ?? query["svc_type"]);
    if (resolved.error !== undefined) {
      return sendForm(
        reply,
        session,
        { ...defaultFormValues(), method: asTrimmed(body.svc_type ?? query["svc_type"]) },
        resolved.error,
        400,
      );
    }
    const method = resolved.method;
    try {
      identity = validateIdentity(body, { requireMobile: method === "M" });
    } catch (err) {
      const sticky = normalizeIdentity(body);
      const detail = err instanceof Error ? err.message : "입력값이 올바르지 않습니다";
      const values: FormValues = {
        method,
        name: sticky.name,
        birthdate: sticky.birthdate,
        gender: sticky.gender,
        nationalInfo: sticky.nationalInfo,
        mobileCo: sticky.mobileCo,
        mobileNo: sticky.mobileNo,
        failCode: asTrimmed(body.fail_code) === "custom" ? "custom" : "",
        failCustom: asTrimmed(body.fail_code_custom),
      };
      return sendForm(reply, session, values, `입력 오류: ${detail}`, 400);
    }

    const updated = updateSession(session.requestNo, {
      status: "SUCCESS",
      identity,
      authMethod: method,
      webTransactionId: newWebTransactionId(),
      failCode: undefined,
    });
    if (updated === undefined) {
      return reply.code(404).type("text/html; charset=utf-8").send(notFoundPage());
    }
    return deliverSuccess(reply, updated);
  });

  app.post("/ido/cert/request/:certId/cancel", async (request, reply) => {
    const session = resolveSession(certIdOf(request));
    if (session === undefined) {
      return reply.code(404).type("text/html; charset=utf-8").send(notFoundPage());
    }
    const updated = updateSession(session.requestNo, { status: "CANCELLED" });
    const closeUrl = (updated ?? session).closeUrl;
    if (closeUrl !== undefined && closeUrl !== "") {
      return reply.redirect(closeUrl);
    }
    return reply.type("text/html; charset=utf-8").send(closePage());
  });
}
