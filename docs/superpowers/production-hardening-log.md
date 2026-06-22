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

### Cycle 2 — docs: api-server access-token-epoch (2026-06-23 ~00:05)
- **Reviewed:** `docs/spec/api-server.md` §4 (token verification) vs `jwt.mjs` / `auth.mjs` / `kb/user.mjs` / `users.mjs`.
- **Found:** (a) spec said `verifyAccessToken()` returns `{ userId, role, jti, exp }` but code returns `{ userId, role, jti, iat, exp }` (`jwt.mjs:105`), and `iat` is load-bearing for the epoch check; (b) the entire access-token-epoch (`tokens_valid_after`) bulk-revocation mechanism — the most security-relevant part of auth — was undocumented; (c) stale line citation (`:100`→`:105`).
- **Changed:** added an "Access-token epoch (bulk revocation)" paragraph (cutoff at `auth.mjs:61`, bumped by `logoutAll`/password-reset, strict-`<` same-second window, added by `0016`), added `iat` to the documented return shape, fixed the citation.
- **Verified:** `make docs-check` green (70 path citations resolve). Caught + fixed a self-inflicted citation slip (`kb/user.mjs` → `extension/kb/user.mjs`) — the guard works.
- **Next up:** Cycle 3 — agent-runtime spec §6: document the multi-provider routing (OpenAI/Google/custom via `providers.mjs`), `runClaudeStream`, and the `--strict-mcp-config` CLI flag (the most-changed file, currently undocumented).

### Cycle 3 — docs: agent-runtime §6 multi-provider routing (2026-06-23 ~00:10)
- **Reviewed:** `docs/spec/agent-runtime.md` §6 vs `extension/agents/runtime.mjs` + `providers.mjs`.
- **Found:** §6 described only "Anthropic HTTP + CLI". Actual `runClaude` routes by provider via `resolveClaudeCall` (runtime.mjs:108) → `completeViaApi`/`runViaCli` for openai/google/custom (`providers.mjs`), with an SSRF guard on `custom.baseUrl`. Also two now-stale specifics: the CLI args gained `--strict-mcp-config` (runtime.mjs:312), and `redactKey` now routes through the shared `core/redact-secrets.mjs` (my earlier merge), not just sk-ant.
- **Changed:** added a "Provider routing" subsection (provider table, prefix mapping, completeViaApi/runViaCli, SSRF guard, vault-first key); corrected the CLI invocation line (`--strict-mcp-config` + rationale); rewrote the key-redaction paragraph to the shared pattern set.
- **Verified:** `make docs-check` green (70 citations resolve).
- **Limitation noted (follow-up):** §5 line ~334 still says foreign-provider ids (GPT/Gemini) "fail the regex and fall back to DEFAULT_MODEL" — with multi-provider routing that's only true on the Anthropic path; `resolveModel`'s Claude-only regex is computed even for non-Anthropic calls (latent trap the review flagged). Needs a careful §5 cross-reference + a code look at `resolveClaudeCall`'s `resolvedModel` usage. Deferred to a code cycle.
- **Next up:** Cycle 4 — chrome-extension spec §4.3/4.5: the "chat history has no hard cap" claim is stale (capped at `MAX_STORED_MESSAGES = 200`).

### Cycle 4 — docs: chrome-extension chat-cap drift (2026-06-23 ~00:16)
- **Reviewed:** `docs/spec/chrome-extension.md` storage table + §4.3/§4.5 vs `hooks/useChat.ts`.
- **Found:** three "no cap / full conversation" claims (lines 249, 292, 300) — all stale; the write path prunes to the most recent `MAX_STORED_MESSAGES = 200` (`useChat.ts:45–48`). `MAX_HISTORY = 10` (LLM context) was accurate.
- **Changed:** all three now state the 200-message retention cap with correct citations.
- **Verified:** `make docs-check` green (70 citations).
- **Next up:** Cycle 5 — macos-app spec: add the unified-knowledge-graph automation surface (KnowledgeGraphService / GraphAutoUpdater / FileClassifier / GraphSessionStore + the doc-notes memory index), entirely absent from the spec.

### Cycle 5 — docs: macos-app KG-automation surface (2026-06-23 ~00:22)
- **Reviewed:** `docs/spec/macos-app.md` §2 EnvironmentObject table + §3 service contracts vs `CodeGraph/*` + this session's memory-index work.
- **Found:** the entire knowledge-graph automation subsystem was undocumented; the EnvironmentObject table omitted `graphAutoUpdater`/`graphSessionStore` (injected at `LlmIdeMacApp.swift:143–144`) and its line range was stale (129–140 → 129–144).
- **Changed:** added the two env-object rows + fixed the range; added a "#### Knowledge-graph automation" §3 contract (KnowledgeGraphService two tracks + merge + md-is-doc + memory index; GraphAutoUpdater triggers/gating; FileClassifier routing; GraphSessionStore cache with laidOut + docFingerprint).
- **Verified:** `make docs-check` green (70 citations).
- **Next up:** Cycle 6 — cross-cutting spec: migration head `0013`→`0016`, the self-documented body-limit `2MB`→`8MB`, and the missing `docs-check` Makefile target in §4. Then Cycle 7 — the value-level drift guard (new `docs/_scripts` check for migration head / `SERVER_API_VERSION` / body-limit) — the meta-fix that would have caught all of the above.

### Cycle 6 — docs: cross-cutting spec drift (2026-06-23 ~00:28)
- **Reviewed:** `docs/spec/cross-cutting.md` §2/§4/§6 vs source + `docs/explanation/security-model.md`.
- **Found & fixed:** (a) head migration `0013` → `0016`; (b) the "known drift: security-model.md says 2 MB" note was itself stale — `security-model.md:18` already says **8 MB**, so I replaced the warning with a statement that both agree; (c) §4 Makefile table omitted `docs-check` (it's at `Makefile:81`, outside the table's "verified 5–79" range) — added the row + extended the range to 5–85.
- **Not-drift confirmed:** line 184 "clients compare apiVersion" is now accurate — this session's extension `apiVersion` fix (on `main`) made it symmetric with the Mac client.
- **Verified:** `make docs-check` green (70 citations).
- **Doc-drift sweep complete** across all 6 spec pages.
- **Next up:** Cycle 7 — add a **value-level drift guard** (`docs/_scripts/check_spec_values.py` + pytest) asserting spec-prose values match source: migration head (count `extension/kb/migrations/*.sql`), `SERVER_API_VERSION`, body-limit default. This closes the gap (file-existence-only guard) that let every drift above pass CI. Then code-hardening cycles (extension-first, in-sandbox).
