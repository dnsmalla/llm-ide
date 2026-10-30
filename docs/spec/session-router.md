---
title: Session router — spec
status: draft
---

This is the contract for the per-chat route (agent-kit K1 Phase 6b): one chat can be pinned to a provider and model, carry a session token limit, and switch provider without carrying its old transcript. Server API version 91. The design record, with the reasoning and the user's answers (Q-R1 to Q-R5), is section 14 of `docs/superpowers/plans/2026-10-30-agent-kit-k1.md`.

Everything here is **off by default**. With the switches below unset, a turn behaves exactly as before: no route row is read or written, the routes answer `enabled: false`, and no new column is on the turn path.

A turn on a catalog model that the router hands to the adapter is never refused for lack of tools: with tools off or unsupported it runs as plain chat and opens with a `tools_unavailable` notice ([provider-catalog](provider-catalog.md) section 7), so a chat pinned to a model without tools keeps working in every mode.

Not covered here: the provider catalog and the adapter ([provider-catalog](provider-catalog.md)), the Claude engine ([claude-linker](../explanation/claude-linker.md)), and the chat file lifecycle (live-then-archive).

---

## §1 What can and cannot be preserved

A prompt cache belongs to one provider and usually one model; it cannot be moved. A switch always pays one cold prefill on the new side. The router makes a switch cheap (a short handoff note and the last turns, never the old transcript) and rare (a pin holds until the user, a rate limit, a provider error or the cap changes it). It cannot make a switch free, and the Mac control says so before the user switches.

Preserved across a switch: the conversation itself (the Mac session file), the handoff note (owned by that file), session memory facts, and the chat's settings. Lost: the old side's cache and, for Claude, the SDK session. Switching away from Claude and back starts a fresh SDK session seeded from the handoff, never a resume of a cold transcript.

## §2 Switches

| Part | Env | Default |
|---|---|---|
| Whole router: route row, routes' effect, pin, counters, notices | `LLMIDE_ROUTER=on` | off |
| Session cap enforcement (needs the router on) | `LLMIDE_ROUTER_CAP=on` | off |
| Prompt compression of adapter turns (needs the router on) | `LLMIDE_ROUTER_COMPRESS=on` | off |
| Learned per-key limits read by the start-of-turn pick | `LLMIDE_ROUTER_LEARN=on` | off |

Each is on only when set to exactly `on` (no trimming or case folding: `ON` and a padded value are off). There is no automatic-switch switch: the router never changes the pick because a cache expired (answer Q-R3), and nothing for it is built. The Mac preference `chat.router` shows or hides the control and, at the next backend start, sets `LLMIDE_ROUTER` for the server it launches.

## §3 Files

| File | Role |
|---|---|
| `extension/core/router-flags.mjs` | The four switches |
| `extension/kb/migrations/0053_chat_session_route.sql` | `chat_session_route`, `provider_learned_limits` (main DB) |
| `extension/kb/agent-migrations/0004_route_events.sql` | `agent_route_events` (agent.db, history only) |
| `extension/kb/chat-route.mjs` | Route store: get, put with compare-and-set, pending, counters, delete, history |
| `extension/kb/learned-limits.mjs` | Learned per-key limits |
| `extension/providers/compress.mjs` | Optional adapter prompt compression |
| `extension/providers/route-policy.mjs` | Pure policy: the pick, warmth, cache TTL table, switch cost, cap state |
| `extension/providers/handoff.mjs` | The handoff note and last turns |
| `extension/routes/agent-v2-router.mjs` | The turn hooks and the three routes |

## §4 The route record

Main DB, not agent.db, because a limit must fail closed: agent.db is "history, never enforcement" and may be down. One row per `(user_id, chat_session_id)`.

- `provider`, `model`: the pin. Both empty means not pinned and the client's own pick governs. `pinned_by` is `user` or `router`.
- `token_limit`: billable tokens for the chat, or null. `0` and null both mean no cap. Negative, fractional, non-numeric and values above 1e12 are refused with 400, never clamped.
- `tokens_in`, `tokens_out`, `tokens_cache_write`: the counters the cap is enforced against. Billable tokens are input plus output plus cache write, the same rule `extension/kb/usage.mjs` uses (answer Q-R1). `tokens_cache_read` is tracked and shown and never counted.
- `warm_json`, `sticky_until`: the last cache touch per `provider|model`, trusted after a restart (a stale value costs one avoidable cold prefill). A stamp more than a minute in the future (a clock moved back) is not trusted as warm.
- `switch_seq`: a version for compare-and-set between two windows.
- `pending_json`: a provider or model change requested while a turn ran.
- `handoff_up_to`: the id of the last message the client's note covers. The server stores no note text (migration 0054 dropped the unused column).
- `last_engine`: `claude`, `adapter` or empty, set by every turn that names a provider. It is what keeps a Claude SDK session from being resumed after an adapter turn even when the warm map was pruned or expired.

`agent_route_events` (agent.db) holds switch history: `switch`, `cap_reached`, `cap_changed`, `handoff_built`. Metadata only: no prompt, no note text. A lost row changes no routing. Rows older than the user's retention horizon are removed by the agent.db rollup.

Rows are bounded per user (5000): when a new row would pass the bound, the least recently updated rows make room. A pin may only name Claude or a custom provider or catalog connection the user owns (else 400), and an unowned provider in a seed is dropped.

Removed with the chat: quit-archive (`purgeWorkingState`), delete-everywhere tombstone replay, `DELETE /agent/v2/session`, and account delete (`deleteUserCascade`, `AGENT_USER_TABLES`). The Mac chat file keeps the pin, the limit and the tokens used, and re-sends them on the next open (§9).

## §5 Turn behaviour

0. **Seed.** A stream request may carry `routeSeed` `{tokenLimit, tokensUsed, provider, model}`, the client's own copy of the route (the Mac chat file; a phone or extension turn sends what it has). When the row is missing it is created from the seed before the cap check, so a first turn after a quit-purge (or a restore that failed or is late) is capped and keeps what the chat had used. A seed can only restore or raise: it never lowers an existing row's counter and never changes its limit or pin. Invalid fields are ignored. The Mac also holds the first send of a reopened chat for up to three seconds while its restore runs.
1. **Early probe** (before the mode classifier's model call): with the router on, read the route. A store error is `503 ROUTE_UNAVAILABLE`; a chat at its cap is `402 SESSION_TOKEN_LIMIT` (402, not the plan's 409: 409 is the turn lock, which every client retries and reports as "still working"). Both are plain JSON before any model call, and the request's rate-limit token is refunded.
2. **Authoritative pass** (the chat's turn lock held, before the SSE headers): check the cap again, then apply a pending change and pick. A refused turn does not consume a pending change. A pinned chat runs on its pin whatever the request says. An adapter provider (`custom:cat-*`) goes through the adapter, never the Claude engine, and its session key is never bound as an SDK session.
3. **A change of provider since the last turn** does not resume a Claude SDK session. The turn is seeded with the handoff.
4. **Never mid-stream.** The pick is made once. A change made during a turn is stored as pending and answers `appliesAt: "next_turn"`; the running turn finishes on its model.
5. **Cap, fail closed.** The remaining billable tokens go to the engine as `maxBillableTokens`. The Claude engine checks as responses stream and ends the turn with the SDK interrupt (a clean result and a resumable transcript; usage totals stay complete); the adapter checks between model calls. Overshoot is bounded by one reply, which the UI says. The stop is a stop, not a switch (answer Q-R5): the Mac offers a one-click raise.
6. **Counters** are committed once per turn (the mode classifier's own call is counted too when the cap is on; a classifier call that reports no usage stays uncounted, a bounded under-count) on every exit path. The engine's single `usage` event commits before the terminal events; an exit with no such event commits from the final totals. After a crash the counter can under-count by at most the running turn and never over-counts.
7. **Notices** (additive `notice` kinds, `warning` for the cap, `info` otherwise): `route_switch` with `{from, to, reason, cold, estimatedPrefillTokens}` after `mode_set`; `session_budget` with `{used, limit, remaining, level}` where level is `warn80` or `reached`. An older Mac ignores the info notices and shows the warning as one status line.

The pick order, with the existing start-of-turn fallback (rate limit, provider error) applied by the adapter after the router, is: pin, then fallback, then cap. Warm expiry never changes the pick.

## §6 Handoff

`providers/handoff.mjs` builds the history a switch carries: one fenced note (background data, not instructions) and the last six turns verbatim. The Mac session file's `summary` owns the note (derived, rebuildable): the client sends it as `summary` (and `summaryUpTo`), the server uses it and stores nothing. Without one, an extractive note is derived from the older turns the client sent, with no model call, capped at 4000 characters (a starting value the bench sets). Everything is redacted first. Only the note's length reaches `agent_route_events`.

## §7 Routes

All token-protected, user-scoped, in `ALL_ENDPOINTS`. Shapes: `schema/http/agent.schema.json`.

| Route | Purpose |
|---|---|
| `GET /agent/v2/session/route?chatSessionId=` | The route, flat, with `enabled` and `capEnforced`. A chat with no row reads as the empty default. Router off: `enabled: false`, nothing read. |
| `PUT /agent/v2/session/route` | `{chatSessionId, provider?, model?, tokenLimit?, tokensUsed?, ifSeq?}`. `provider` is `anthropic` or `custom:<id>` and travels with `model`. `ifSeq` is compare-and-set: stale is `409 ROUTE_CONFLICT` with `details.current`. Router off: `409 ROUTER_DISABLED`. Answers the route plus `appliesAt`, `changed`, and for a provider change `coldSwitch` and `estimatedPrefillTokens`. |
| `GET /agent/v2/session/route/history?chatSessionId=` | `{events, degraded}`; `degraded: true` and no events when agent.db is down. |

`tokensUsed` re-seeds the counter of a chat whose route was purged at quit. It is honoured only while the row has no usage, so a client can only lower its own limit's progress, which defeats nothing but the user's own cap.

## §8 Learned limits and compression

**Learned limits** (`LLMIDE_ROUTER_LEARN=on`). `provider_learned_limits` holds per-key rpm, rpd, tpm and tpd, fed from rate-limit header snapshots (`recordRateLimits`, which the adapter calls for every response, a 429 included). A bare 429 is never turned into a number (it does not say which limit was hit); it only parks the key for a short cooldown. A new observation replaces the whole row, so a dimension it does not carry does not outlive its own expiry. Read by `pickTurnProvider` as `limit_near` (at 90 percent of a learned requests or tokens per minute figure, measured from this user's ledger). A value the user set always wins and never expires (`setUserLimit`; no route or screen writes one in v1, and the limits a user sets for built-in providers live in `model_limits`, consulted first by `getLimits`); a learned value expires after 24 hours without a fresh observation. A near-limit key is skipped for the next turn only, never mid-stream, and only in favour of the user's own ordered fallback list (no rotation across accounts).

**Compression** (`LLMIDE_ROUTER_COMPRESS=on`, router on). `providers/compress.mjs` runs on adapter turns only (never the Claude path, whose prompt the SDK builds): it caps long outputs of an allowlisted set of tools (web search, URL fetch, shell, KB and code search, listings, sub-agents) keeping head and tail, and stubs an identical repeat call only while the first full result is still within the recent context (same tool, same arguments, same content). File-content tools (`read-file`), loaded skills, citation checks, tasks and decisions are never cut or stubbed, and neither is an error. Older history messages keep head and tail. Every tool result is redacted, objects included. JSON compaction is not done. Redaction runs first. Nothing it produces is stored.

## §9 The Mac control

A small control in the chat header (Chat feature): provider and model, the cap with presets, a one-line meter `used / limit` with cache reads shown separately, a cold-switch warning ("switching loses the cache: about N tokens on the next turn"), and a one-click raise at the cap. Switch history appears in the agent history view. The Mac chat file mirrors the pin, the limit and the tokens used as one optional `route` key (`provider`, `model`, `tokenLimit`, `tokensUsed`), also written to the `chat-tags.json` sidecar so an older build's re-save cannot lose it (re-applied on load only, so clearing a limit sticks), and PUTs it back when the chat opens, which recreates the route purged at quit (`ifSeq: 0`, `tokensUsed` as the seed). The control and the Settings switch (`chat.router`, `chat.router.cap`, applied at the next backend start) are in `Features/Chat` and `Features/Settings`; the notices decode into `AgentV2Event.routeSwitch` and `.sessionBudget`. The switch history list sits in the control's popover; the Agents hub history view does not show it yet. The phone sees the route through the Mac; the phone protocol is unchanged.

## §10 Bounds and open items

- The cap is approximate to one reply on both engines. A crash under-counts by at most one turn.
- The cache TTL table (`providers/route-policy.mjs`) carries `source`: Anthropic and OpenRouter are the user's figures, every other provider is `assumed` at ten minutes until a bench run measures it. A wrong TTL changes only when a switch is priced cheap, never whether it is allowed.
- Not built, by decision: automatic switching on warm expiry (Q-R3), extension-side chats (Q-R4), a per-chat cheaper fallback model at the cap.
- Bench scenarios `switch-handoff`, `capped-session` and `compress-long-tools` (scenario set version 4) exist and are structure-tested in fake mode; their paid runs are not done. See [run the token bench](../how-to/run-the-token-bench.md).
- Paid bench runs (compression on or off, handoff size, TTL probes, switch cost) are the user's; every default stays as in §2 until they are run.
