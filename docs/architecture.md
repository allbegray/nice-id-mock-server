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

`auth_url` 을 브라우저로 열면 인증 폼이 나온다. 이름, 생년월일, 성별, 내외국인, 통신사, 휴대폰번호를 입력하고 완료를 누른다. 폼에는 자주 쓰는 실패 코드 프리셋 선택란도 있다.

### `?auto=1` (자동 완료)

기본 신원(`홍길동`)으로 바로 성공 처리하고 `return_url` 로 이동한다. curl로 흐름을 확인할 때 쓴다. `fail=` 과 함께 오면 `fail=` 이 이긴다.

### `fail=` 주입

`auth_url?fail=3032` 처럼 열거나 폼의 실패 코드란에 값을 넣으면 해당 코드로 실패 처리된다. `3` 으로 시작하는 4자리 코드만 유효하고, 그 외 값은 무시하고 성공 경로로 간다. 실패 코드는 세션에 저장되어 `/auth/result` 응답에도 그대로 나타난다. 예를 들어 `fail=3032` 로 실패한 뒤 `/auth/result` 를 호출하면 `result_code 3032` (HTTP 200) 가 돌아온다. `fail=3029` 면 `result_code 3029` 가 돌아온다.

### 취소와 `close_url`

`POST /ido/cert/request/:certId/cancel` 로 취소하면 세션이 `CANCELLED` 가 된다. `/auth/url` 요청에 `close_url` 을 넣었다면 그 주소로 302 리다이렉트하고, 없으면 "인증을 취소했습니다" 안내 페이지를 보여준다.

