# Production-hardening loop — journal

Autonomous self-paced improvement run requested 2026-06-22 ~23:50 (operator asleep, ~7h window → target stop ~2026-06-23 07:00). Goal: raise the system toward production/professional quality via repeated cycles of *review docs → improve → review code → find limitations → improve*.

## Guardrails (self-imposed)
- **Branch only:** all work on `chore/production-hardening`. **Never merge to or push `main`.** Push this branch periodically as a backup; operator reviews + merges when awake.
- **Verify every change** before commit: `make docs-check` for docs; `cd extension && npm test` for extension; `cd mac && swift build && swift test` (with `dangerouslyDisableSandbox`) for Mac. Never commit red.
- **Focused & reversible:** one well-scoped improvement per cycle, with rationale. No sweeping rewrites. YAGNI. Match existing style.
- **Don't ship what I can't verify:** Mac GUI runtime behavior isn't drivable headlessly — stick to build/test-verifiable changes; flag anything uncertain here rather than forcing it.
- **Roadmap** is grounded in this session's architecture review (six-subsystem findings) + the user's doc-first ordering.

## Roadmap (priority order; doc-first)
1. **Spec drift** (docs): KB migration inventory ✅; api-server access-token-epoch + `iat`; agent-runtime §6 multi-provider routing; chrome-extension chat cap; macos-app KG-automation section; cross-cutting migration head / body-limit.
2. **Value-level drift guard** (docs tooling): extend `docs/_scripts` to check spec *values* (migration head, `SERVER_API_VERSION`, body-limit), not just file-path existence — the gap that let the drift above pass CI.
3. **Code hardening** (verifiable, TDD): planner→graphkit boundary; `search()` entity tenancy gating consistency; agent loop hard deadline (AbortSignal); `docSetFingerprint` deterministic ordering on large repos.
4. Re-review each change adversarially; record limitations found.

## Cycle log

### Cycle 1 — docs: KB migration inventory drift (2026-06-22 ~23:55)
- **Reviewed:** `docs/spec/knowledge-base.md` §1 migrations table vs `extension/kb/migrations/` on disk.
- **Found:** spec said "0001 … 0013 (13 files)"; disk has through `0016` (16). `make docs-check` passed anyway — the citation guard only checks *file-path existence*, not values (confirms the review's drift-guard gap).
- **Verified:** 0014/0015 = AFTER-UPDATE FTS triggers; 0016 = `users.tokens_valid_after ADD COLUMN`; no new tables since 0013, so the "20 tables" list stays correct.
- **Changed:** migrations row now reads "through `0016_token_epoch.sql` (16 files)" with a one-line note on what 0014–0016 added.
- **Verified:** `make docs-check` green (80 pytest + 3 guards).
- **Next up:** Cycle 2 — api-server spec: document the access-token-epoch mechanism + `iat` in the `verifyAccessToken` return shape (security-relevant, currently undocumented).
