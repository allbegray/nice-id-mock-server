# 빠른 시작 (상세)

← [README](../README.md)

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

결과 조회의 `request_no` 는 **`/auth/token` 에서 만든 값** 을 그대로 쓴다. 흐름 전체가 같은 `request_no` 로 이어지므로 `/auth/url` 에 다른 값을 넣으면 `400/1004`, `/auth/result` 에 다른 값을 넣으면 `200/3029` 가 온다.

```bash
# 아이핀(svc_types I) 흐름: 같은 request_no 로 url -> 아이핀 전용 결과 필드
IPIN=$(curl -s -X POST http://localhost:8899/ido/intc/v1.0/auth/url \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d "{\"request_no\":\"$REQ\",\"return_url\":\"http://localhost:8080/nice-id/return?requestNo=$REQ\",\"svc_types\":[\"I\"],\"method_type\":\"GET\"}")
IPIN_AUTH=$(printf '%s' "$IPIN" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).auth_url")
IPIN_TX=$(printf '%s' "$IPIN" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).transaction_id")
IPIN_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$IPIN_AUTH?auto=1")
IPIN_WTID=${IPIN_LOC##*web_transaction_id=}
curl -s -X POST http://localhost:8899/ido/intc/v1.0/auth/result \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d "{\"request_no\":\"$REQ\",\"transaction_id\":\"$IPIN_TX\",\"web_transaction_id\":\"$IPIN_WTID\"}"
```

`enc_data` 를 복호화하면 이번엔 `mobile_co`/`mobile_no` 대신 `ci_update`, `vnumber`, `age_code`, `auth_method` 가 들어 있다 ([docs/architecture.md](architecture.md)의 인증수단 표).

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

