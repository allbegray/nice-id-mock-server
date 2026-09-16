# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately via
[GitHub Security Advisories](https://github.com/allbegray/nice-id-mock-server/security/advisories/new)
for this repository.

Alternative: email allbegray@gmail.com.

Please do not open a public issue for a suspected vulnerability.
Include steps to reproduce, affected version/commit, and any logs
with secrets and personal data redacted.

## Warning: Local-Only Mock, Unauthenticated Admin

This mock is for local development only. Do not expose it publicly.

- `/admin` and `/admin/clients*` (the admin page and management API)
  have NO authentication. Anyone who can reach port `8899` can create,
  read, rotate, and delete client credentials. Use it on the local
  loopback only; do not open the port to the outside.
- Never put real NICE credentials (`client-id`, `client-secret`) or real
  NICE endpoints here. Use only dummy values such as `test-client-id`,
  `test-client-secret`, or `demo-client-01`.
- Never use real personal data. The default identity
  (`홍길동 / 19000208 / 01012345678`) is fixed test data.
- Do not leave personal identifiers such as `ci` or `di` in logs.
  Do not paste raw token values into logs or captures
  (mask them and check only the leading characters).

## Supported Versions

Only the latest `main` is supported with security updates.
