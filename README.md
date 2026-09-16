# NICE 본인인증 목 서버 (nice-id-mock)

로컬 개발용 NICE 본인인증 API 목 서버. 실 NICE 서버 없이도 토큰 발급부터 표준창 인증, 암호화 결과 조회까지 전체 흐름을 로컬에서 돌릴 수 있다.

기본 신원은 `홍길동 / 19000208 / 01012345678` 로 고정되어 있어 테스트 결과가 결정적이다.

## 아키텍처

```
[앱 서버] -- 1. POST /auth/token (Basic) --> [mock :8899]
[앱 서버] <-- access_token, ticket, iterators -- [mock]
[앱 서버] -- 2. POST /auth/url (Bearer) ---> [mock]
[앱 서버] <-- auth_url, transaction_id ----- [mock]
[앱 서버] -- 3. auth_url을 브라우저에 표시 --> [사용자 브라우저]
[브라우저] -- 4. GET /ido/cert/request/:certId -> [mock 표준창]
[사용자] -- 5. 표준창 폼 작성 후 완료 -----> [mock]
[mock] -- 6. 302 return_url?requestNo=..&web_transaction_id=.. --> [브라우저]
[브라우저] -- 7. return_url 호출 ------------> [앱 서버 콜백]
[앱 서버] -- 8. POST /auth/result (Bearer) -> [mock]
[앱 서버] <-- enc_data, integrity_value --- [mock]
[앱 서버] -- 9. ticket으로 복호화, 이름/휴대폰 확인
```

흐름 요약: 앱은 mock과 `token, url, result` 3개 API로 대화하고, 사용자는 브라우저로 표준창을 열어 인증을 마친 뒤 `return_url` 로 돌아온다.

## Quick start

```bash
docker compose up -d --build
```

```bash
curl -s http://localhost:8899/health
# {"status":"UP"}
```

```bash
REQ="test-request-no-0123456789"
CRED=$(printf '%s:%s' 'test-client-id' 'test-client-secret' | base64 | tr -d '\n')
TOKEN_RESP=$(curl -s -X POST http://localhost:8899/ido/intc/v1.0/auth/token \
  -H "Authorization: Basic $CRED" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"client_credentials\",\"request_no\":\"$REQ\"}")
echo "$TOKEN_RESP"
ACCESS=$(printf '%s' "$TOKEN_RESP" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")
echo "access_token=$ACCESS"
```

```bash
URL_RESP=$(curl -s -X POST http://localhost:8899/ido/intc/v1.0/auth/url \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d "{\"request_no\":\"$REQ\",\"return_url\":\"http://localhost:8080/nice-id/return?requestNo=$REQ\",\"svc_types\":[\"M\"],\"method_type\":\"GET\"}")
echo "$URL_RESP"
AUTH_URL=$(printf '%s' "$URL_RESP" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).auth_url")
TXID=$(printf '%s' "$URL_RESP" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).transaction_id")
echo "auth_url=$AUTH_URL"
```

```bash
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$AUTH_URL?auto=1")
echo "$LOC"
WTID=${LOC##*web_transaction_id=}
echo "web_transaction_id=$WTID"
```

```bash
curl -s -X POST http://localhost:8899/ido/intc/v1.0/auth/result \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d "{\"request_no\":\"$REQ\",\"transaction_id\":\"$TXID\",\"web_transaction_id\":\"$WTID\"}"
```

```bash
REQ2="test-request-no-9876543210"
TOKEN2=$(curl -s -X POST http://localhost:8899/ido/intc/v1.0/auth/token \
  -H "Authorization: Basic $CRED" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"client_credentials\",\"request_no\":\"$REQ2\"}")
ACCESS2=$(printf '%s' "$TOKEN2" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).access_token")
URL2=$(curl -s -X POST http://localhost:8899/ido/intc/v1.0/auth/url \
  -H "Authorization: Bearer $ACCESS2" \
  -H 'Content-Type: application/json' \
  -d "{\"request_no\":\"$REQ2\",\"return_url\":\"http://localhost:8080/nice-id/return?requestNo=$REQ2\",\"svc_types\":[\"M\"],\"method_type\":\"GET\"}")
AUTH_URL2=$(printf '%s' "$URL2" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).auth_url")
echo "auth_url2=$AUTH_URL2"
curl -s "$AUTH_URL2?fail=3032" | grep -o '실패 코드: [0-9]*'
CERT2=${AUTH_URL2##*/}
curl -s -X POST "http://localhost:8899/ido/cert/request/$CERT2/cancel" | grep -o '인증을 취소했습니다'
```

```bash
docker compose down
```

위 블록을 순서대로 한 셸에서 실행하면 토큰 발급, 표준창 자동 완료, 결과 조회, 실패 주입, 취소까지 전부 확인할 수 있다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8899` | 컨테이너 리슨 포트. 바꾸면 compose의 `8899:8899` 호스트 매핑도 함께 바꿔야 한다 |
| `HOST` | `0.0.0.0` | 바인드 주소 |
| `PUBLIC_BASE_URL` | `http://localhost:8899` | `auth_url` 생성 기준 URL. 반드시 브라우저에서 도달 가능한 주소일 것 (컨테이너 내부 주소 금지) |
| `CLIENT_ID` | `test-client-id` | 최초 1회 시드 값 (런타임 고정 아님, 이후 변경은 Admin API로) |
| `CLIENT_SECRET` | `test-client-secret` | 최초 1회 시드 값 (런타임 고정 아님, 이후 변경은 Admin API로) |
| `STRICT_CREDENTIALS` | `true` | `true`면 DB에 등록된 클라이언트만 통과 (미등록 1006), `false`면 DB 조회 생략, 아무 Basic 통과 (로컬 디버깅용) |
| `TOKEN_TTL_MS` | `86400000` | 접근 토큰 유효시간 (24시간, ms) |
| `AUTH_URL_TTL_MS` | `600000` | 인증창 유효시간 (10분, ms) |
| `ITERATORS` | `66` | 결과 암호화 반복 횟수. 클라이언트 복호화와 같은 값이어야 한다 |
| `STRICT_ONE_TIME_RESULT` | `false` | `true`면 `/auth/result` 성공 조회를 1회로 제한, 2회째는 `3033` |
| `DB_PATH` | `data/niceid.db` | SQLite 파일 경로. `:memory:` 면 휘발성 인메모리 DB (영속화 없음). 상대 경로는 프로세스 cwd 기준 |

`CLIENT_ID`/`CLIENT_SECRET` 은 첫 부팅 때 빈 DB에 한 번만 심는 시드 값이다. 이후 토큰 발급 검사는 DB(`clients` 테이블)를 보므로, 실행 중 자격증명을 바꾸려면 서버를 재시작하는 게 아니라 Admin API(`POST /admin/clients`, `PUT /admin/clients/:clientId`)나 `/admin` 페이지를 쓴다. `src/config.ts` 의 `Config` 필드와 1:1로 대응한다 (`port`, `host`, `publicBaseUrl`, `clientId`, `clientSecret`, `strictCredentials`, `tokenTtlMs`, `authUrlTtlMs`, `iterators`, `strictOneTimeResult`, `dbPath`).

주의: compose의 `ports` 는 `8899:8899` 고정이다. `PORT` 만 바꾸고 매핑을 그대로 두면 호스트에서 접속이 안 된다.

## 엔드포인트 계약

| 메서드 | 경로 | 인증 | 성공 응답 |
|---|---|---|---|
| `GET` | `/health` | 없음 | `{"status":"UP"}` |
| `POST` | `/ido/intc/v1.0/auth/token` | `Basic` (ID:시크릿) | `result_code 0000`, `access_token`, `expires_in`, `token_type`, `iterators`, `ticket` |
| `POST` | `/ido/intc/v1.0/auth/url` | `Bearer` | `result_code 0000`, `auth_url`, `transaction_id` |
| `POST` | `/ido/intc/v1.0/auth/result` | `Bearer` | `result_code 0000`, `enc_data`, `integrity_value` |
| `GET` | `/ido/cert/request/:certId` | 없음 (표준창) | 인증 폼 HTML, 또는 `auto=1` 시 성공 전달 |
| `POST` | `/ido/cert/request/:certId/complete` | 없음 (폼 제출) | 성공 전달, 또는 입력 오류 시 400 폼 재표시 |
| `POST` | `/ido/cert/request/:certId/cancel` | 없음 (취소) | `close_url` 있으면 302, 없으면 취소 안내 페이지 |

성공 전달 방식은 `method_type` 에 따라 다르다. `GET` 이면 `return_url` 에 `web_transaction_id` 를 쿼리로 합쳐 302 리다이렉트한다 (기존 `requestNo` 쿼리는 유지된다). `POST` 면 숨은 `web_transaction_id` 필드를 담은 자동 제출 폼 HTML 200을 돌려준다.

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

## 영속화 동작

클라이언트와 세션은 SQLite(`data/niceid.db`)에 저장된다. compose는 `./data:/app/data` 바인드 마운트를 쓰므로, 프로세스 재시작뿐 아니라 `docker compose down` 후 `docker compose up -d` 로 컨테이너를 새로 만들어도 클라이언트와 세션이 그대로 남는다. 파일 DB는 WAL 모드로 열리므로, 실행 중에는 `data/` 안에 `niceid.db` 와 함께 `-wal`, `-shm` 사이드카 파일이 보일 수 있다 (정상이다).

TTL은 재시작 후에도 그대로 적용된다. 만료된 접근 토큰으로 `/auth/url` 이나 `/auth/result` 를 부르면 HTTP 400 `1003`, 인증창 유효시간이 지난 세션으로 `/auth/result` 를 부르면 HTTP 200 `3032` 가 돌아온다. 재시작 전에 발급받은 Bearer는 TTL 안이면 재시작 후에도 유효하다.

시드 진리표 (`seedDefaultClientIfEmpty` 기준, `meta.seeded_at` 마커로 판단):

1. 첫 부팅 (마커 없음 + 테이블 비어 있음): 환경변수 값으로 시드하고 마커를 기록한다.
2. 이후 재시작 때 테이블이 비어 있어도 (마커 있음): 다시 시드하지 않는다. 클라이언트를 전부 지운 건 유효한 상태이며, 복구는 Admin API 생성으로만 한다.
3. `STRICT_CREDENTIALS=false`: DB 조회를 통째로 건너뛰고 아무 Basic 값이나 통과한다.
4. 클라이언트 삭제 후에도 이미 발급된 토큰은 TTL까지 유효하다. 세션은 별도 테이블 행이라 삭제의 영향을 받지 않는다.

주의: 세션 테이블에 자동 상한이 없다. 오래 돌리면 행이 계속 쌓이므로, 가끔 직접 비워준다.

```bash
# 만료된 세션만 지우기 (ms epoch 비교)
sqlite3 data/niceid.db "DELETE FROM sessions WHERE token_expires_at < $(node -p 'Date.now()');"
```

```bash
# 세션 전체 비우기 (클라이언트는 유지)
sqlite3 data/niceid.db "DELETE FROM sessions;"
```

`sqlite3` 바이너리가 없으면 `npm` 스크립트나 Admin API로 같은 작업을 해도 된다. 핵심은 자동 정리가 없다는 점만 기억한다.

## 초기화와 백업

```bash
# 초기화: 서버/compose를 멈춘 뒤 data 디렉터리 삭제, 다시 올리면 기본값으로 재시드된다
docker compose down
rm -rf ./data
docker compose up -d --build
```

```bash
# 백업: db 파일 복사 (실행 중이면 -wal/-shm 사이드카도 함께 복사)
cp data/niceid.db /tmp/niceid-backup.db
cp data/niceid.db-wal /tmp/niceid-backup.db-wal 2>/dev/null || true
cp data/niceid.db-shm /tmp/niceid-backup.db-shm 2>/dev/null || true
```

비 compose 실행이면 첫 줄 대신 서버 프로세스를 멈추고 같은 `rm -rf ./data` 를 쓴다. `DB_PATH` 를 바꿔 쓴 경우 위 경로의 `data/niceid.db` 를 실제 `DB_PATH` 값으로 읽는다. `DB_PATH=:memory:` 로 띄운 경우는 파일이 없으니 백업 대상도 없고, 프로세스가 끝나면 데이터가 전부 사라진다.

## TTL

| 대상 | 유효시간 | 만료 시 동작 |
|---|---|---|
| 접근 토큰 | 24시간 (`TOKEN_TTL_MS`) | `/auth/url`, `/auth/result` 에서 HTTP 400 `1003` |
| 인증창 (`auth_url`, `transaction_id`) | 10분 (`AUTH_URL_TTL_MS`) | 표준창 404 페이지, `/auth/result` 에서 HTTP 200 `3032` |

## 표준창 사용법

### 수동 폼

`auth_url` 을 브라우저로 열면 인증 폼이 나온다. 이름, 생년월일, 성별, 내외국인, 통신사, 휴대폰번호를 입력하고 완료를 누른다. 폼에는 자주 쓰는 실패 코드 프리셋 선택란도 있다.

### `?auto=1` (자동 완료)

기본 신원(`홍길동`)으로 바로 성공 처리하고 `return_url` 로 이동한다. curl로 흐름을 확인할 때 쓴다. `fail=` 과 함께 오면 `fail=` 이 이긴다.

### `fail=` 주입

`auth_url?fail=3032` 처럼 열거나 폼의 실패 코드란에 값을 넣으면 해당 코드로 실패 처리된다. `3` 으로 시작하는 4자리 코드만 유효하고, 그 외 값은 무시하고 성공 경로로 간다. 실패 코드는 세션에 저장되어 `/auth/result` 응답에도 그대로 나타난다. 예를 들어 `fail=3032` 로 실패한 뒤 `/auth/result` 를 호출하면 `result_code 3032` (HTTP 200) 가 돌아온다. `fail=3029` 면 `result_code 3029` 가 돌아온다.

### 취소와 `close_url`

`POST /ido/cert/request/:certId/cancel` 로 취소하면 세션이 `CANCELLED` 가 된다. `/auth/url` 요청에 `close_url` 을 넣었다면 그 주소로 302 리다이렉트하고, 없으면 "인증을 취소했습니다" 안내 페이지를 보여준다.

## common-spring 배선

`NiceIdProperties` (prefix `nice-id`) 필드와 1:1로 맞는 yaml이다. 로컬 mock을 바라보게 `base-url` 만 mock 주소로 두면 된다.

```yaml
nice-id:
  base-url: http://localhost:8899
  client-id: test-client-id
  client-secret: test-client-secret
  return-url: http://localhost:8080/nice-id/return
  close-url: http://localhost:8080/nice-close.html
```

키는 `nice-id.base-url`, `nice-id.client-id`, `nice-id.client-secret`, `nice-id.return-url`, `nice-id.close-url` 5개이며, `NiceIdProperties` 의 `baseUrl`, `clientId`, `clientSecret`, `returnUrl`, `closeUrl` 과 순서대로 대응한다.

## return_url 수신 컨트롤러 예시

아래는 앱 측 참고용 샘플이다. 배포 코드가 아니며 이 저장소에 포함되어 있지 않다.

```kotlin
// 샘플: 앱 측 참고용 (not shipped)
@RestController
class NiceIdReturnSampleController(
    private val niceIdService: NiceIdService,
) {
    @GetMapping("/nice-id/return")
    fun returnGet(
        @RequestParam("requestNo") requestNo: String,
        @RequestParam("web_transaction_id") webTransactionId: String,
    ) = niceIdService.authResult(requestNo, webTransactionId)

    @PostMapping("/nice-id/return")
    fun returnPost(
        @RequestParam("requestNo") requestNo: String,
        @RequestParam("web_transaction_id") webTransactionId: String,
    ) = niceIdService.authResult(requestNo, webTransactionId)
}
```

파라미터 이름은 `NiceIdService.authResult(requestNo, webTransactionId)` 시그니처와 같다. `method_type: POST` 인 경우 mock이 자동 제출 폼의 action에 원래 `return_url` (쿼리의 `requestNo` 포함)을 그대로 쓰므로, POST 본문의 `web_transaction_id` 와 쿼리의 `requestNo` 가 함께 도착한다. 그래서 GET/POST 두 변형 모두 같은 파라미터로 받으면 된다.

## 수동 테스트 시나리오

1. 앱을 실행하고 mock을 바라보게 배선한다 (`nice-id.base-url: http://localhost:8899`).
2. 앱의 표준창 URL 발급 API를 호출해 `authUrl` 을 얻는다.
3. 브라우저로 `authUrl` 을 열어 표준창 폼을 직접 작성하고 완료를 누른다 (또는 빠르게 확인할 땐 `?auto=1`).
4. 브라우저가 앱의 `return-url` 로 돌아오는지 확인한다 (`requestNo` 와 `web_transaction_id` 포함).
5. 앱 로그나 결과 조회 API에서 복호화된 이름/휴대폰번호가 뜨는지 확인한다.

## 트러블슈팅

| 증상 | 원인, 실제 mock 동작 | 해결 |
|---|---|---|
| 브라우저에서 표준창이 안 열림 | `auth_url` 은 `PUBLIC_BASE_URL` 기준으로 만든다 (`src/routes/authUrl.ts:104-108`). 컨테이너 내부 주소가 들어가면 브라우저가 못 닿는다 | `PUBLIC_BASE_URL` 을 브라우저에서 도달 가능한 주소로 둔다 |
| docker에서 브라우저 접속이 안 됨 | compose `ports` 가 `8899:8899` 고정이다 (`docker-compose.yml:8-9`). `PORT` 만 바꾸면 호스트 매핑과 어긋난다 | `PORT` 변경 시 매핑도 같이 바꾼다. 앱 컨테이너에서 브라우저용 URL이 필요하면 `host.docker.internal` 을 쓴다 |
| `request_no` 관련 400 | 20자 미만, 50자 초과면 HTTP 400 `1002` (`src/routes/authToken.ts:105-108`, `src/routes/authUrl.ts:28-30`, `src/routes/authResult.ts:108-111`) | `request_no` 를 20자 이상 50자 이하로 맞춘다 |
| 재시작 후에도 이전 Bearer가 유효 | 저장소가 SQLite + `./data` 바인드 마운트라 재시작해도 클라이언트와 세션이 유지된다. TTL 안의 토큰은 재시작 후에도 `0000` 으로 동작한다. 세션이 사라지는 건 `rm -rf ./data` 로 파일을 지웠을 때뿐이다 | 파일 삭제 후엔 흐름을 처음부터 다시 돌린다 (토큰 재발급부터) |
| 표준창 404 페이지 | 인증창이 만료되었거나 존재하지 않는 `certId` 다 (`src/routes/certWindow.ts:88-98`, `238-242`). 토큰 재발급으로 회전(rotation)되면 이전 토큰과 `certId` 가 무효가 된다 (`src/store.ts:79-84`) | `POST /auth/url` 로 인증 URL을 다시 발급받는다 |
| `/auth/result` 가 `3032` (HTTP 200) | 인증 유효시간 초과 (`src/routes/authResult.ts:129-131`), 표준창 미완료 (`136-138`), `web_transaction_id` 불일치 (`139-141`), 또는 `fail=` 주입 실패 (`132-135`) | 10분 안에 완료하는지, 전달된 `web_transaction_id` 가 맞는지, `fail=` 을 붙이지 않았는지 확인한다 |
| 토큰 만료 `1003` (HTTP 400) | 24시간 경과 (`src/routes/authUrl.ts:53-55`, `src/routes/authResult.ts:94-96`) | 토큰을 다시 발급받는다 |
| 알 수 없는 토큰 `1004` (HTTP 400) | Bearer 토큰이 세션에 없거나 회전으로 무효화됨 (`src/routes/authUrl.ts:49-52`, `src/routes/authResult.ts:90-93`) | 해당 `request_no` 로 토큰을 다시 발급받는다 |
| 자격증명 거부 `1006` (HTTP 400) | DB 기준 판정이다 (`src/routes/authToken.ts:90-93`, `src/clients.ts:65-74`). 미등록 ID, 삭제된 클라이언트, 교체 후 이전 시크릿이면 전부 `1006` 이다. `CLIENT_ID`/`CLIENT_SECRET` 환경변수는 첫 시드용이라 실행 중 값과 다를 수 있다 | `GET /admin/clients` 로 등록 목록을 확인하고, 필요하면 Admin API로 생성/수정한다. 로컬 디버깅용으로만 `STRICT_CREDENTIALS=false` 를 쓴다 |
| Authorization 누락 `1001` (HTTP 400) | `Basic` 헤더 없음, 빈 값, 깨진 base64 (`src/routes/authToken.ts:65-71`) | `Authorization: Basic <base64url(ID:시크릿)>` 형식을 확인한다 |
| JSON 아님 `3001` (HTTP 200) | 본문이 JSON 객체가 아니면 200으로 `3001` (`src/routes/authToken.ts:98-101`, `src/routes/authResult.ts:100-103`) | `Content-Type: application/json` 과 본문 형식을 확인한다 |
| 두 번째 결과 조회 `3033` (HTTP 200) | `STRICT_ONE_TIME_RESULT=true` 일 때만, 조회済み 세션 재조회 (`src/routes/authResult.ts:143-146`) | 기본값 `false` 에선 재조회가 그대로 성공한다. `true` 로 뒀다면 새 흐름을 시작한다 |
| 테스트마다 결과가 다름 | 기본 신원은 고정 (`src/config.ts:55-62`)이고 `auto=1` 도 같은 신원으로 성공한다 (`src/routes/certWindow.ts:251-263`). 결과가 달라졌다면 폼에 다른 값을 직접 입력한 것이다 | 결정적인 확인이 필요하면 `?auto=1` 을 쓴다 |
| Linux에서 부팅 시 `SQLITE_CANTOPEN` 또는 `unable to open database file` | `./data` 바인드 마운트 디렉터리의 호스트 권한 문제다. 이미지의 비 root 유저와 호스트 uid가 다르면 DB 파일을 못 만든다 | 먼저 `mkdir -p data` 로 디렉터리를 만든다. 그래도 안 되면 `chmod 777 data` 로 풀거나 compose에 `user:` 오버라이드로 uid를 맞춘다 |
| 동시 실행 시 DB 잠금/쓰기 충돌 | SQLite는 단일 프로세스 쓰기를 전제한다. 서버 두 개나 컨테이너 두 개가 같은 `data/niceid.db` 를 동시에 쓰면 충돌한다 | 한 번에 하나의 서버/컨테이너만 띄운다. 두 구성이 필요하면 `DB_PATH` 를 서로 다르게 둔다 |

## CI/DI 생성 규칙

`ci`, `di`는 `/auth/result` 조회 시점에 계산한다. 저장하지 않으므로 같은 입력이면 항상 같은 값이 나온다 (`src/identity.ts:141-160`).

- CI 프리이미지: `nice-mock-ci|{name}|{birthdate}|{gender}|{nationalInfo}` (`deriveCi`, `src/identity.ts:152-155`)
- DI 프리이미지: `nice-mock-di|{clientId}|{name}|{birthdate}|{gender}|{nationalInfo}` (`deriveDi`, `src/identity.ts:157-160`). `clientId`는 토큰 발급 때 세션에 기록된 값이라 사이트마다 DI가 다르다
- 인코딩: 프리이미지 UTF-8 바이트에 SHA-512, base64url 무패딩. 64바이트라 항상 86자, 결정적 (`digestBase64UrlNoPad`, `src/identity.ts:141-143`)
- 휴대폰번호·통신사는 CI·DI 프리이미지에 들어가지 않는다. 번호·통신사가 바뀌어도 CI·DI는 그대로다. 이름 안의 `|`는 그대로 합친다 (목 한계)
- 이 버전에서 규칙이 바뀌어 동일인이어도 CI/DI 값이 이전과 다를 수 있음 — 목 전용
- 실 NICE의 CI/DI와 무관하다. `test-client-id` 같은 더미로만 확인한다

## 보안 경고

- 이 mock은 로컬 개발용이다. 외부에 노출하지 않는다. 특히 관리 API(`/admin`, `/admin/clients*`)에는 인증이 전혀 없으므로, `8899` 포트를 외부에 열면 누구나 자격증명을 만들고 바꿀 수 있다. 로컬 루프백에서만 쓴다.
- 실 NICE 자격증명(`client-id`, `client-secret`)과 실 NICE 엔드포인트를 여기에 넣지 않는다. 예시의 `test-client-id`, `test-client-secret`, `demo-client-01` 같은 더미만 쓴다.
- `ci`, `di` 같은 개인식별정보를 로그에 남기지 않는다. 토큰 원문을 로그나 캡처에 붙여넣지 않는다 (확인할 땐 앞자리만 마스킹해서 본다).
