---
title: Error codes
source: extension/server/errors.mjs
---

<!-- generated from extension/server/errors.mjs - do not edit by hand -->

# Error codes

Every error response uses the envelope `{ error: { code, message, details } }`.

| Code | HTTP status | Description |
|---|---|---|
| `AUTH_REQUIRED` | 401 | - |
| `CONFLICT` | 409 | - |
| `FORBIDDEN` | 403 | - |
| `GUARDRAIL_FAILED` | 422 | - |
| `INTERNAL_ERROR` | 500 | - |
| `NOT_FOUND` | 404 | - |
| `RATE_LIMITED` | 429 | - |
| `UPSTREAM_ERROR` | 502 | - |
| `VALIDATION_FAILED` | 400 | - |
