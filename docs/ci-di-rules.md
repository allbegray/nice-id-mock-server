# CI/DI 생성 규칙

← [README](../README.md)

## CI/DI 생성 규칙

`ci`, `di`는 `/auth/result` 조회 시점에 계산한다. 저장하지 않으므로 같은 입력이면 항상 같은 값이 나온다 (`src/identity.ts:158-178`).

- CI 프리이미지: `nice-mock-ci|{name}|{birthdate}|{gender}|{nationalInfo}` (`deriveCi`, `src/identity.ts:169-172`)
- DI 프리이미지: `nice-mock-di|{clientId}|{name}|{birthdate}|{gender}|{nationalInfo}` (`deriveDi`, `src/identity.ts:174-177`). `clientId`는 토큰 발급 때 세션에 기록된 값이라 사이트마다 DI가 다르다
- 인코딩: 프리이미지 UTF-8 바이트에 SHA-512, base64url 무패딩. 64바이트라 항상 86자, 결정적 (`digestBase64UrlNoPad`, `src/identity.ts:158-160`)
- 휴대폰번호·통신사는 CI·DI 프리이미지에 들어가지 않는다. 번호·통신사가 바뀌어도 CI·DI는 그대로다. 이름 안의 `|`는 그대로 합친다 (목 한계)
- 이 버전에서 규칙이 바뀌어 동일인이어도 CI/DI 값이 이전과 다를 수 있음 — 목 전용
- 실 NICE의 CI/DI와 무관하다. `test-client-id` 같은 더미로만 확인한다
- CI/DI는 인증수단(svc_types)과 무관하게 같은 규칙으로 계산된다. 아이핀 전용 필드(`vnumber`, `age_code`) 유도는 [architecture.md](architecture.md) 를 본다

