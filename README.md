# NICE 본인인증 목 서버 (nice-id-mock-server)

A local mock server for NICE identity verification (token → standard window → encrypted result) so you can develop the full flow without the real NICE service. Node 26 + SQLite persistence.

[![CI](https://github.com/allbegray/nice-id-mock-server/actions/workflows/ci.yml/badge.svg)](https://github.com/allbegray/nice-id-mock-server/actions/workflows/ci.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/allbegray/nice-id-mock-server)](https://hub.docker.com/r/allbegray/nice-id-mock-server)

로컬 개발용 NICE 본인인증 API 목 서버. 실 NICE 서버 없이도 토큰 발급부터 표준창 인증, 암호화 결과 조회까지 전체 흐름을 로컬에서 돌릴 수 있다.

기본 신원은 `홍길동 / 19000208 / 01012345678` 로 고정되어 있어 테스트 결과가 결정적이다.

## Docker로 실행

```bash
docker pull allbegray/nice-id-mock-server:v0.1.2
```

```bash
docker run -d -p 127.0.0.1:8899:8899 -e PUBLIC_BASE_URL=http://localhost:8899 -v niceid-data:/app/data allbegray/nice-id-mock-server:v0.1.2
curl -s http://localhost:8899/health
```

- Docker Hub: https://hub.docker.com/r/allbegray/nice-id-mock-server
- GHCR 미러: `ghcr.io/allbegray/nice-id-mock-server` (`docker pull ghcr.io/allbegray/nice-id-mock-server:v0.1.2`)

태그 정책: `latest`는 최신 릴리즈, `vX.Y.Z`는 고정 핀이다. 재현이 필요하면 버전을 찍어 쓴다.

익명 pull은 100 pulls/6h 제한이 있다. 한도를 넘기면 `docker login` 후 다시 받는다.

> `/admin` and `/admin/clients*` have NO authentication and can create/rotate credentials — bind to loopback / never expose this container to a public host.

## Docker Compose

```yaml
services:
  nice-id-mock-server:
    image: allbegray/nice-id-mock-server:v0.1.2
    container_name: nice-id-mock-server
    ports:
      - "127.0.0.1:8899:8899"
    environment:
      - PUBLIC_BASE_URL=http://localhost:8899
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

이 repo의 `docker-compose.yml`은 로컬 소스 빌드용이다 (`build: .`). 위 스니펫은 게시 이미지 실행용이다.

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
| `GET` | `/` | 없음 | 프로젝트 정보 JSON (`name`, `version`, `description`, `repository`, `docs`, `endpoints`, `defaultIdentity`) |
| `GET` | `/health` | 없음 | `{"status":"UP"}` |
| `POST` | `/ido/intc/v1.0/auth/token` | `Basic` (ID:시크릿) | `result_code 0000`, `access_token`, `expires_in`, `token_type`, `iterators`, `ticket` |
| `POST` | `/ido/intc/v1.0/auth/url` | `Bearer` | `result_code 0000`, `auth_url`, `transaction_id` |
| `POST` | `/ido/intc/v1.0/auth/result` | `Bearer` | `result_code 0000`, `enc_data`, `integrity_value` |
| `GET` | `/ido/cert/request/:certId` | 없음 (표준창) | 인증 폼 HTML, 또는 `auto=1` 시 성공 전달 |
| `POST` | `/ido/cert/request/:certId/complete` | 없음 (폼 제출) | 성공 전달, 또는 입력 오류 시 400 폼 재표시 |
| `POST` | `/ido/cert/request/:certId/cancel` | 없음 (취소) | `close_url` 있으면 302, 없으면 취소 안내 페이지 |

성공 전달 방식은 `method_type` 에 따라 다르다. `GET` 이면 `return_url` 에 `web_transaction_id` 를 쿼리로 합쳐 302 리다이렉트한다 (기존 `requestNo` 쿼리는 유지된다). `POST` 면 숨은 `web_transaction_id` 필드를 담은 자동 제출 폼 HTML 200을 돌려준다.

## CI/DI 생성 규칙

CI는 휴대폰번호·통신사와 무관하게 이름·생년월일·성별·내외국인으로 결정된다.
DI는 같은 입력에 `clientId`가 더해져 사이트마다 다르게 결정된다.
인코딩은 SHA-512 base64url 무패딩 86자로 항상 결정적이다. 규칙 전체는 [docs/ci-di-rules.md](docs/ci-di-rules.md)를 본다.

## 상세 문서

- [docs/quickstart.md](docs/quickstart.md) — 토큰부터 결과 조회·실패 주입까지 전체 curl 워크스루.
- [docs/architecture.md](docs/architecture.md) — 9단계 흐름 다이어그램과 표준창(`auto`, `fail`, 취소) 사용법.
- [docs/admin-api.md](docs/admin-api.md) — 로컬 전용 클라이언트 CRUD와 `/admin` 페이지 사용법.
- [docs/operations.md](docs/operations.md) — 영속화·TTL·초기화/백업·트러블슈팅.
- [docs/wiring.md](docs/wiring.md) — common-spring 배선과 `return_url` 수신 예시.
- [docs/ci-di-rules.md](docs/ci-di-rules.md) — CI/DI 프리이미지와 인코딩 규칙 원문.

## 보안 경고

- 이 mock은 로컬 개발용이다. 외부에 노출하지 않는다. 특히 관리 API(`/admin`, `/admin/clients*`)에는 인증이 전혀 없으므로, `8899` 포트를 외부에 열면 누구나 자격증명을 만들고 바꿀 수 있다. 로컬 루프백에서만 쓴다.
- 실 NICE 자격증명(`client-id`, `client-secret`)과 실 NICE 엔드포인트를 여기에 넣지 않는다. 예시의 `test-client-id`, `test-client-secret`, `demo-client-01` 같은 더미만 쓴다.
- `ci`, `di` 같은 개인식별정보를 로그에 남기지 않는다. 토큰 원문을 로그나 캡처에 붙여넣지 않는다 (확인할 땐 앞자리만 마스킹해서 본다).

## 라이선스

MIT. 자세한 내용은 `LICENSE` 파일을 본다.
