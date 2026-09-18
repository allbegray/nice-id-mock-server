# 아키텍처

← [README](../README.md)

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


## 표준창 사용법

### 수동 폼

`auth_url` 을 브라우저로 열면 인증 폼이 나온다. 인증수단, 이름, 생년월일, 성별, 내외국인, (휴대폰인증이면) 통신사·휴대폰번호를 입력하고 완료를 누른다. 폼에는 자주 쓰는 실패 코드 프리셋 선택란도 있다.

### 인증수단 선택 (`svc_type`)

선택지는 `/auth/url` 이 지정한 `svc_types` 안에서만 나온다. 첫 값이 기본 선택이고, 휴대폰(M)이 아니면 통신사·번호 입력란이 숨는다. `?svc_type=I` 처럼 쿼리로 미리 고를 수 있고, 목록 밖의 값이면 400 폼 재표시다.

완료한 수단은 세션(`authMethod`)에 남고 결과 JSON 필드를 정한다 (`RESULT_JSON_KEYS_BY_METHOD`, `src/identity.ts`):

| 수단 | 결과 필드 (`name`, `birthdate`, `gender`, `national_info`, `ci`, `di` 공통) |
|---|---|
| `M` 휴대폰 | `mobile_co`, `mobile_no` |
| `I` 아이핀 | `ci_update`(=`0`), `vnumber`, `age_code`, `auth_method`(=`5`) |
| `F`/`U` 인증서 | 없음 (공통 필드만) |

아이핀 전용 값은 CI/DI와 같은 결정성 규칙으로 유도한다: `vnumber`는 `nice-mock-vn\|이름\|생년월일\|성별\|내외국인` 의 SHA-256 다이제스트에서 십진수 10자리, `age_code`는 생년월일의 만 나이를 가이드 구간(9세미만=0 … 20세이상=7)에 매핑한 값이다. 조회 시점의 날짜를 쓰므로 `age_code` 만은 날마다 달라질 수 있다.

### `?auto=1` (자동 완료)

기본 신원(`홍길동`)으로 바로 성공 처리하고 `return_url` 로 이동한다. curl로 흐름을 확인할 때 쓴다. 인증수단은 `svc_types` 의 첫 값이고, `?auto=1&svc_type=I` 처럼 지정할 수도 있다. `fail=` 과 함께 오면 `fail=` 이 이긴다.

### `fail=` 주입

`auth_url?fail=3032` 처럼 열거나 폼의 실패 코드란에 값을 넣으면 해당 코드로 실패 처리된다. `3` 으로 시작하는 4자리 코드만 유효하고, 그 외 값은 무시하고 성공 경로로 간다. 실패 코드는 세션에 저장되어 `/auth/result` 응답에도 그대로 나타난다. 예를 들어 `fail=3032` 로 실패한 뒤 `/auth/result` 를 호출하면 `result_code 3032` (HTTP 200) 가 돌아온다. `fail=3029` 면 `result_code 3029` 가 돌아온다.

### 취소와 `close_url`

`exp_mods` 에 `closeButtonOn` 을 넣었을 때만 표준창에 닫기 버튼이 생긴다 (가이드: 닫기 버튼은 옵션). 버튼은 `POST /ido/cert/request/:certId/cancel` 로 세션을 `CANCELLED` 로 만든다. `/auth/url` 요청에 `close_url` 을 넣었다면 그 주소로 302 리다이렉트하고, 없으면 "인증을 취소했습니다" 안내 페이지를 보여준다.

