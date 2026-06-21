---
title: Error codes
source: extension/core/errors.mjs
---

<!-- generated from extension/core/errors.mjs - do not edit by hand -->

# Error codes

Every error response uses the envelope `{ error: { code, message, details } }`.

| Code | HTTP status | Description |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Missing or invalid bearer token; client must (re)authenticate. |
| `CONFLICT` | 409 | The action conflicts with the current server state (e.g. duplicate resource). |
| `FORBIDDEN` | 403 | Authenticated but the requested resource does not belong to this user. |
| `INTERNAL_ERROR` | 500 | Unhandled server error; check server logs with LLMIDE_LOG_LEVEL=debug. |
| `NOT_FOUND` | 404 | No such resource exists; pass a noun or a full "not found" phrase. |
| `RATE_LIMITED` | 429 | Token-bucket rate limit exhausted; retryAfterSec in details, Retry-After in header. |
| `VALIDATION_FAILED` | 400 | Request body failed schema or range checks; details carries field-level errors. |
