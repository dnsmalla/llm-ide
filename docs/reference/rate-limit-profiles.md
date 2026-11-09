---
title: Rate-limit profiles
source: extension/server/rate-limit.mjs
---

<!-- generated from extension/server/rate-limit.mjs - do not edit by hand -->

# Rate-limit profiles

Token-bucket per `(profile, scope)`. Scope is `userId` for authenticated routes, the remote IP for unauthenticated ones. `429` responses include a `Retry-After` header.

| Profile | Burst | Refill window | Notes |
|---|---|---|---|
| `agentTurn` | 12 | 5 s / token | ~1 every 5s, burst 12 |
| `authEmailFail` | 10 | 30 s / token | Failed-login bucket, keyed by normalized email. Charged ONLY on a failed password, so a correct login is not held at zero by someone else's spray; 10 burst, then one guess per 30 s (~3k/day). The per-IP authPublic bucket still applies on top. |
| `authEmailIpFail` | 10 | 30 s / token | Hard block for one email from one IP. A spray from one address cannot lock the account out from another address, and a correct password is never pre-blocked by the looser email bucket. |
| `authPublic` | 10 | 1 s / token | Shared bucket for login + refresh — keyed by remote IP. 10-burst then 1/sec to absorb a password-manager fill without blocking the UI, but still stop credential-stuffing loops. |
| `authRegister` | 3 | 60 s / token | Tighter dedicated bucket for account registration. 3 burst (covers a mistype/retry flow) then 1 per 60 s per IP. Registration is infrequent by design; spam registrations create real DB rows so the cost of being too permissive is higher here. |
| `dispatch` | 4 | 10 s / token | ~1 every 10s, burst 4 |
| `kbExport` | 5 | 10 s / token | Bulk export reads (GET /kb/export-all). Each call streams an entire user's meeting corpus out of SQLite, so it's far heavier than a normal read. Cap it so a script can't hammer the endpoint and turn it into a DB-amplification DoS, while still allowing legitimate paged exports (burst 5, then ~1 every 10s for follow-up cursor pages). |
| `kbWrite` | 30 | 0.20 s / token (5/s) | 5/sec, burst 30 |
| `liveAppend` | 30 | 0.20 s / token (5/s) | 5/sec, burst 30 |
| `llm` | 3 | 30 s / token | ~1 every 30s, burst 3 |
| `llmFast` | 6 | 5 s / token | ~1 every 5s, burst 6 |
| `outcomePoll` | 6 | 30 s / token | ~1 every 30s, burst 6 |
| `unknownFallback` | 10 | 1 s / token | Applied to any profile name tryConsume does not recognize. Before this existed an unknown name FAILED OPEN — a route whose profile was typo'd or never added ran unthrottled forever, with only a one-line warning to show for it. Tight enough that a runaway loop is still stopped, loose enough that a config gap degrades to back-pressure rather than an outage. |
