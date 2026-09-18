# 운영

← [README](../README.md)

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

## 트러블슈팅

| 증상 | 원인, 실제 mock 동작 | 해결 |
|---|---|---|
| 브라우저에서 표준창이 안 열림 | `auth_url` 은 `PUBLIC_BASE_URL` 기준으로 만든다 (`src/routes/authUrl.ts:104-110`). 컨테이너 내부 주소가 들어가면 브라우저가 못 닿는다 | `PUBLIC_BASE_URL` 을 브라우저에서 도달 가능한 주소로 둔다 |
| docker에서 브라우저 접속이 안 됨 | compose `ports` 가 `8899:8899` 고정이다 (`docker-compose.yml:8-9`). `PORT` 만 바꾸면 호스트 매핑과 어긋난다 | `PORT` 변경 시 매핑도 같이 바꾼다. 앱 컨테이너에서 브라우저용 URL이 필요하면 `host.docker.internal` 을 쓴다 |
| `request_no` 관련 400 | 20자 미만, 50자 초과면 HTTP 400 `1002` (`src/routes/authToken.ts:108-110`, `src/routes/authUrl.ts:28-30`, `src/routes/authResult.ts:112-114`) | `request_no` 를 20자 이상 50자 이하로 맞추고, token 발급 때 만든 값을 `/auth/url`·`/auth/result` 에도 그대로 쓴다. 다르면 url 은 `1004`, result 는 `3029` 다 |
| 결과 조회 `3029` (HTTP 200) | 보낸 `request_no` 로 세션을 찾지 못했거나(다른 값, 오타, `/auth/url` 미호출) `transaction_id` 가 세션 값과 다르다 (`src/routes/authResult.ts:125-129`) | token 발급 때 만든 `request_no` 와 `/auth/url` 응답의 `transaction_id` 를 그대로 보낸다 |
| 재시작 후에도 이전 Bearer가 유효 | 저장소가 SQLite + `./data` 바인드 마운트라 재시작해도 클라이언트와 세션이 유지된다. TTL 안의 토큰은 재시작 후에도 `0000` 으로 동작한다. 세션이 사라지는 건 `rm -rf ./data` 로 파일을 지웠을 때뿐이다 | 파일 삭제 후엔 흐름을 처음부터 다시 돌린다 (토큰 재발급부터) |
| 표준창 404 페이지 | 인증창이 만료되었거나 존재하지 않는 `certId` 다 (`src/routes/certWindow.ts:129-139`). 토큰 재발급으로 회전(rotation)되면 이전 토큰과 `certId` 가 무효가 된다 (`src/store.ts:161-162`) | `POST /auth/url` 로 인증 URL을 다시 발급받는다 |
| `/auth/result` 가 `3032` (HTTP 200) | 인증 유효시간 초과 (`src/routes/authResult.ts:132-134`), `fail=` 주입 실패 (`135-137`), 표준창 미완료 (`138-140`), `web_transaction_id` 불일치 (`141-143`) | 10분 안에 완료하는지, 전달된 `web_transaction_id` 가 맞는지, `fail=` 을 붙이지 않았는지 확인한다 |
| 토큰 만료 `1003` (HTTP 400) | 24시간 경과 (`src/routes/authUrl.ts:53-55`, `src/routes/authResult.ts:94-96`) | 토큰을 다시 발급받는다 |
| 알 수 없는 토큰 `1004` (HTTP 400) | Bearer 토큰이 세션에 없거나 회전으로 무효화됨 (`src/routes/authUrl.ts:45-52`, `68-70`, `src/routes/authResult.ts:80-87`) | 해당 `request_no` 로 토큰을 다시 발급받는다 |
| 자격증명 거부 `1006` (HTTP 400) | DB 기준 판정이다 (`src/routes/authToken.ts:92-96`, `src/clients.ts:65-74`). 미등록 ID, 삭제된 클라이언트, 교체 후 이전 시크릿이면 전부 `1006` 이다. `CLIENT_ID`/`CLIENT_SECRET` 환경변수는 첫 시드용이라 실행 중 값과 다를 수 있다 | `GET /admin/clients` 로 등록 목록을 확인하고, 필요하면 Admin API로 생성/수정한다. 로컬 디버깅용으로만 `STRICT_CREDENTIALS=false` 를 쓴다 |
| Authorization 누락 `1001` (HTTP 400) | `Basic` 헤더 없음, 빈 값, 깨진 base64 (`src/routes/authToken.ts:64-82`) | `Authorization: Basic <base64url(ID:시크릿)>` 형식을 확인한다. 표준 base64(`+`, `/`)로 보내도 같은 값이면 통과한다 |
| JSON 아님 `3001` (HTTP 200) | 본문이 JSON 객체가 아니면 200으로 `3001` (`src/routes/authToken.ts:100-103`, `src/routes/authResult.ts:104-106`) | `Content-Type: application/json` 과 본문 형식을 확인한다 |
| 두 번째 결과 조회 `3033` (HTTP 200) | `STRICT_ONE_TIME_RESULT=true` 일 때만, 조회済み 세션 재조회 (`src/routes/authResult.ts:147-149`). 실 서비스는 이 재조회를 기본으로 막는다 | 기본값 `false` 에선 재조회가 그대로 성공한다. `true` 로 뒀다면 새 흐름을 시작한다 |
| 테스트마다 결과가 다름 | 기본 신원은 고정 (`src/config.ts:55-62`)이고 `auto=1` 도 같은 신원으로 성공한다 (`src/routes/certWindow.ts:321-328`). 결과가 달라졌다면 폼에 다른 값을 직접 입력한 것이다 | 결정적인 확인이 필요하면 `?auto=1` 을 쓴다 |
| Linux에서 부팅 시 `SQLITE_CANTOPEN` 또는 `unable to open database file` | `./data` 바인드 마운트 디렉터리의 호스트 권한 문제다. 이미지의 비 root 유저와 호스트 uid가 다르면 DB 파일을 못 만든다 | 먼저 `mkdir -p data` 로 디렉터리를 만든다. 그래도 안 되면 `chmod 777 data` 로 풀거나 compose에 `user:` 오버라이드로 uid를 맞춘다 |
| 동시 실행 시 DB 잠금/쓰기 충돌 | SQLite는 단일 프로세스 쓰기를 전제한다. 서버 두 개나 컨테이너 두 개가 같은 `data/niceid.db` 를 동시에 쓰면 충돌한다 | 한 번에 하나의 서버/컨테이너만 띄운다. 두 구성이 필요하면 `DB_PATH` 를 서로 다르게 둔다 |

