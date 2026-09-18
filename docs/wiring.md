# 연동

← [README](../README.md)

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

파라미터 이름은 `NiceIdService.authResult(requestNo, webTransactionId)` 시그니처와 같다. 여기서 `requestNo` 는 **`/auth/token` 발급 때 만든 값** 이어야 한다 — request_no 는 흐름 전체를 잇는 키라서 `/auth/url`·`/auth/result` 모두 같은 값이어야 하고, 목은 다른 값을 `400/1004`(url) / `200/3029`(result) 로 거절한다. `method_type: POST` 인 경우 mock이 자동 제출 폼의 action에 원래 `return_url` (쿼리의 `requestNo` 포함)을 그대로 쓰므로, POST 본문의 `web_transaction_id` 와 쿼리의 `requestNo` 가 함께 도착한다. 그래서 GET/POST 두 변형 모두 같은 파라미터로 받으면 된다.

## 수동 테스트 시나리오

1. 앱을 실행하고 mock을 바라보게 배선한다 (`nice-id.base-url: http://localhost:8899`).
2. 앱의 표준창 URL 발급 API를 호출해 `authUrl` 을 얻는다.
3. 브라우저로 `authUrl` 을 열어 표준창 폼을 직접 작성하고 완료를 누른다 (또는 빠르게 확인할 땐 `?auto=1`).
4. 브라우저가 앱의 `return-url` 로 돌아오는지 확인한다 (`requestNo` 와 `web_transaction_id` 포함).
5. 앱 로그나 결과 조회 API에서 복호화된 이름/휴대폰번호가 뜨는지 확인한다.

