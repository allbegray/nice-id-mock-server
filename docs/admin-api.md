# 관리 API

← [README](../README.md)

## 관리 API (로컬 전용, 무인증)

런타임에 클라이언트 자격증명을 바꾸는 CRUD다. 인증 없이 열려 있으므로 로컬에서만 쓴다. NICE `result_code` 봉투를 쓰지 않고, 오류 본문은 항상 `{"error": ..., "message": ...}` 형태다. `error` 값은 정확히 셋 중 하나다: `bad_request` (400), `not_found` (404), `conflict` (409).

| 메서드 | 경로 | 성공 상태 | 성공 본문 |
|---|---|---|---|
| `POST` | `/admin/clients` | `201` | 전체 시크릿 포함, 딱 한 번만 반환 (`clientId`, `clientSecret`, `createdAt`, `updatedAt`) |
| `GET` | `/admin/clients` | `200` | 마스킹 목록 (`{clients: [{clientId, clientSecretMasked, createdAt, updatedAt}]}`) |
| `GET` | `/admin/clients/:clientId` | `200` | 마스킹 단건 (`clientId`, `clientSecretMasked`, `createdAt`, `updatedAt`) |
| `PUT` | `/admin/clients/:clientId` | `200` | 마스킹 단건 (바뀐 시크릿 기준) |
| `DELETE` | `/admin/clients/:clientId` | `204` | 빈 본문 |
| `GET` | `/admin` | `200` | 관리 페이지 HTML (아래 `/admin` 페이지 사용법 참고) |

제약: `clientId` 는 `^[A-Za-z0-9._-]{1,64}$` (`:` 금지, Basic 인증 파싱과 충돌). `clientSecret` 은 1자 이상 128자 이하, 공백/제어문자 금지. 목록/단건/수정 응답의 시크릿은 마스킹된다 (`앞 4자 + ****`, 4자 이하면 `****` 전체). 전체 시크릿은 생성 응답에서만 볼 수 있으니 따로 보관한다.

아래 예시는 전부 그대로 복사해 실행할 수 있다. `demo-client-01` 같은 더미 ID만 쓰며, 실 자격증명은 절대 넣지 않는다.

```bash
# 생성: 201, 전체 시크릿이 딱 한 번 반환된다
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:8899/admin/clients \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"demo-client-01","clientSecret":"demo-secret-01"}'
```

```bash
# 목록: 200, 시크릿은 마스킹된다
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8899/admin/clients
```

```bash
# 단건 조회: 200, 마스킹된다
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8899/admin/clients/demo-client-01
```

```bash
# 수정(시크릿 교체): 200, 마스킹된다. 이전 시크릿으로는 토큰 발급이 1006으로 거부된다
curl -s -w '\nHTTP %{http_code}\n' -X PUT http://localhost:8899/admin/clients/demo-client-01 \
  -H 'Content-Type: application/json' \
  -d '{"clientSecret":"demo-secret-02"}'
```

```bash
# 삭제: 204, 빈 본문
curl -s -w '\nHTTP %{http_code}\n' -X DELETE http://localhost:8899/admin/clients/demo-client-01
```

```bash
# 오류 예시: 없는 클라이언트 조회는 404 not_found
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8899/admin/clients/no-such-client
# {"error":"not_found","message":"..."}
```

```bash
# 오류 예시: 중복 생성은 409 conflict
curl -s -X POST http://localhost:8899/admin/clients \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"demo-client-01","clientSecret":"demo-secret-01"}'
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:8899/admin/clients \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"demo-client-01","clientSecret":"demo-secret-01"}'
# 두 번째 호출: {"error":"conflict","message":"..."} + HTTP 409
curl -s -X DELETE http://localhost:8899/admin/clients/demo-client-01
```

```bash
# 오류 예시: 형식 위반은 400 bad_request
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:8899/admin/clients \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"bad:id","clientSecret":"demo-secret-01"}'
# {"error":"bad_request","message":"..."} + HTTP 400
```

## `/admin` 페이지 사용법

브라우저로 `http://localhost:8899/admin` 을 연다.

1. 목록: 접속하면 등록된 클라이언트가 표로 보인다 (`clientId`, 마스킹된 시크릿, `createdAt`, `updatedAt`).
2. 생성: 하단 "클라이언트 생성" 폼에 ID와 시크릿을 넣고 제출한다. 전체 시크릿은 생성 직후 한 번만 화면에 뜨니 바로 복사해 둔다.
3. 수정: 목록 행의 수정 버튼으로 시크릿을 교체한다. 이후 이전 시크릿으로 발급한 토큰 요청은 `1006` 으로 거부된다.
4. 삭제: 목록 행의 삭제 버튼을 누른다. 이미 발급된 토큰은 TTL이 끝날 때까지 계속 유효하다 (회수되지 않는다).

상단 경고 배너("경고: 이 페이지는 인증이 없으며 로컬 전용입니다. 외부에 노출하지 마세요.")는 이 페이지와 관리 API 전체에 인증이 없다는 뜻이다. 포트를 외부에 열지 말고 로컬에서만 쓴다.

