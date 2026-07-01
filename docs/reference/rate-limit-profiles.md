---
title: Rate-limit profiles
source: extension/server/rate-limit.mjs
---

<!-- generated from extension/server/rate-limit.mjs - do not edit by hand -->

# Rate-limit profiles

Token-bucket per `(profile, scope)`. Scope is `userId` for authenticated routes, the remote IP for unauthenticated ones. `429` responses include a `Retry-After` header.

| Profile | Burst | Refill window | Notes |
|---|---|---|---|
| `authPublic` | 10 | 1 s / token | Shared bucket for login + refresh — keyed by remote IP. 10-burst then 1/sec to absorb a password-manager fill without blocking the UI, but still stop credential-stuffing loops. |
| `authRegister` | 3 | 60 s / token | Tighter dedicated bucket for account registration. 3 burst (covers a mistype/retry flow) then 1 per 60 s per IP. Registration is infrequent by design; spam registrations create real DB rows so the cost of being too permissive is higher here. |
| `dispatch` | 4 | 10 s / token | ~1 every 10s, burst 4 |
| `kbExport` | 5 | 10 s / token | Bulk export reads (GET /kb/export-all). Each call streams an entire user's meeting corpus out of SQLite, so it's far heavier than a normal read. Cap it so a script can't hammer the endpoint and turn it into a DB-amplification DoS, while still allowing legitimate paged exports (burst 5, then ~1 every 10s for follow-up cursor pages). |
| `kbWrite` | 30 | 0.20 s / token (5/s) | 5/sec, burst 30 |
| `liveAppend` | 30 | 0.20 s / token (5/s) | 5/sec, burst 30 |
| `llm` | 3 | 30 s / token | ~1 every 30s, burst 3 |
| `llmFast` | 6 | 5 s / token | ~1 every 5s, burst 6 |
| `outcomePoll` | 6 | 30 s / token | ~1 every 30s, burst 6 |
