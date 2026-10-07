# NICE 본인인증 Mock Server

로컬 개발용 NICE 본인인증 목 서버다. 토큰 발급부터 표준창 인증, 암호화 결과 조회까지 전체 흐름을 실 서버 없이 돌린다.
Bun + SQLite 영속화로 로컬에서 바로 실행된다.

## 빠른 시작

이미지 받기:

```bash
docker pull allbegray/nice-id-mock-server:v0.2.0
```

컨테이너 실행 후 상태 확인:

```bash
docker run -d -p 127.0.0.1:8899:8899 -e PUBLIC_BASE_URL=http://localhost:8899 -v niceid-data:/app/data allbegray/nice-id-mock-server:v0.2.0
curl -s http://localhost:8899/health
```

상태 응답이 `{"status":"UP"}` 이면 정상이다.

## Docker Compose

게시 이미지 실행용 스니펫이다:

```yaml
services:
  nice-id-mock-server:
    image: allbegray/nice-id-mock-server:v0.2.0
    container_name: nice-id-mock-server
    ports:
      - "127.0.0.1:8899:8899"
    environment:
      - PUBLIC_BASE_URL=http://localhost:8899
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

실행:

```bash
docker compose up -d
```

참고로 이 저장소의 `docker-compose.yml` 파일은 로컬 소스 빌드용(`build: .`)이므로 위 스니펫과는 용도가 다르다.

## 주요 환경변수

자주 쓰는 변수만 추렸다. 기본값은 그대로 둔다:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:8899` | 인증창 주소 생성 기준. 브라우저에서 도달 가능한 주소여야 한다 |
| `PORT` | `8899` | 컨테이너 리슨 포트. 바꾸면 호스트 매핑도 함께 바꾼다 |
| `DB_PATH` | `data/niceid.db` | SQLite 파일 경로. `:memory:` 는 휘발성이다 |
| `STRICT_CREDENTIALS` | `true` | 등록된 클라이언트만 통과. `false` 는 로컬 디버깅용이다 |
| `ITERATORS` | `66` | 결과 암호화 반복 횟수. 복호화 측과 같아야 한다 |
| `TOKEN_TTL_MS` | `86400000` | 접근 토큰 유효시간. 24시간이다 |
| `AUTH_URL_TTL_MS` | `600000` | 인증창 유효시간. 10분이다 |
| `STRICT_ONE_TIME_RESULT` | `false` | `true` 면 결과 조회를 1회로 제한하고 2회째는 `3033` 이다 |

전체 환경변수 표는 아래 링크의 GitHub 저장소에서 확인한다.

## 태그

`latest` 는 최신 릴리즈를 가리킨다. 재현이 필요하면 `vX.Y.Z` 형식으로 버전을 찍어 쓴다.
익명 풀은 100 pulls/6h 제한이 있으므로 한도를 넘기면 `docker login` 후 다시 받는다.

## 보안 경고

관리 API인 `/admin` 과 `/admin/clients*` 에는 인증이 전혀 없다. 자격증명을 만들고 바꿀 수 있으므로 반드시 루프백에서만 쓰고 외부에 절대 노출하지 않는다.
실 NICE 자격증명과 실 NICE 엔드포인트를 넣지 않는다. 더미 값만 쓴다.

## 링크

- [GitHub 저장소](https://github.com/allbegray/nice-id-mock-server)
- [퀵스타트](https://github.com/allbegray/nice-id-mock-server/blob/main/docs/quickstart.md)
- [운영 안내](https://github.com/allbegray/nice-id-mock-server/blob/main/docs/operations.md)
- [라이선스](https://github.com/allbegray/nice-id-mock-server/blob/main/LICENSE)

이 프로젝트는 MIT 라이선스다.
