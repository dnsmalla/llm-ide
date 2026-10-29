---
title: Session router — spec
status: draft
---

This is the contract for the per-chat route (agent-kit K1 Phase 6b): one chat can be pinned to a provider and model, carry a session token limit, and switch provider without carrying its old transcript. Server API version 91. The design record, with the reasoning and the user's answers (Q-R1 to Q-R5), is section 14 of `docs/superpowers/plans/2026-10-30-agent-kit-k1.md`.

Everything here is **off by default**. With the switches below unset, a turn behaves exactly as before: no route row is read or written, the routes answer `enabled: false`, and no new column is on the turn path.

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

Each is on only when set to exactly `on`. There is no automatic-switch switch: the router never changes the pick because a cache expired (answer Q-R3), and nothing for it is built. The Mac preference `chat.router` shows or hides the control and, at the next backend start, sets `LLMIDE_ROUTER` for the server it launches.

## §3 Files

| File | Role |
|---|---|
| `extension/core/router-flags.mjs` | The four switches |
| `extension/kb/migrations/0053_chat_session_route.sql` | `chat_session_route`, `provider_learned_limits` (main DB) |
| `extension/kb/agent-migrations/0004_route_events.sql` | `agent_route_events` (agent.db, history only) |
| `extension/kb/chat-route.mjs` | Route store: get, put with compare-and-set, pending, counters, delete, history |
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
- `handoff_up_to`: the id of the last message the client's note covers. `handoff_note` is never written in v1 (Mac chats only, answer Q-R4).

`agent_route_events` (agent.db) holds switch history: `switch`, `cap_reached`, `cap_changed`, `handoff_built`. Metadata only: no prompt, no note text. A lost row changes no routing. Rows older than the user's retention horizon are removed by the agent.db rollup.

Removed with the chat: quit-archive (`purgeWorkingState`), delete-everywhere tombstone replay, `DELETE /agent/v2/session`, and account delete (`deleteUserCascade`, `AGENT_USER_TABLES`). The Mac chat file keeps the pin, the limit and the tokens used, and re-sends them on the next open (§9).

## §5 Turn behaviour

1. **Early probe** (before the mode classifier's model call): with the router on, read the route. A store error is `503 ROUTE_UNAVAILABLE`; a chat at its cap is `409 SESSION_TOKEN_LIMIT`. Both are plain JSON before any model call, and the request's rate-limit token is refunded.
2. **Authoritative pass** (the chat's turn lock held, before the SSE headers): apply a pending change, check the cap again, and pick. A pinned chat runs on its pin whatever the request says. An adapter provider (`custom:cat-*`) goes through the adapter, never the Claude engine, and its session key is never bound as an SDK session.
3. **A change of provider since the last turn** does not resume a Claude SDK session. The turn is seeded with the handoff.
4. **Never mid-stream.** The pick is made once. A change made during a turn is stored as pending and answers `appliesAt: "next_turn"`; the running turn finishes on its model.
5. **Cap, fail closed.** The remaining billable tokens go to the engine as `maxBillableTokens`. The Claude engine checks as responses stream and ends the turn with the SDK interrupt (a clean result and a resumable transcript; usage totals stay complete); the adapter checks between model calls. Overshoot is bounded by one reply, which the UI says. The stop is a stop, not a switch (answer Q-R5): the Mac offers a one-click raise.
6. **Counters** are committed once per turn on every exit path. The engine's single `usage` event commits before the terminal events; an exit with no such event commits from the final totals. After a crash the counter can under-count by at most the running turn and never over-counts.
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

**Learned limits** (`LLMIDE_ROUTER_LEARN=on`). `provider_learned_limits` holds per-key rpm, rpd, tpm and tpd, fed from rate-limit header snapshots (`recordRateLimits`) and from 429s, and read by `pickTurnProvider` as `limit_near` (at 90 percent of a learned requests or tokens per minute figure, measured from this user's ledger). A value the user set always wins and never expires; a learned value expires after 24 hours without a fresh observation. A near-limit key is skipped for the next turn only, never mid-stream, and only in favour of the user's own ordered fallback list (no rotation across accounts).

**Compression** (`LLMIDE_ROUTER_COMPRESS=on`, router on). `providers/compress.mjs` runs on adapter turns only (never the Claude path, whose prompt the SDK builds): it drops repeated identical tool outputs and file reads, caps tool outputs by characters keeping head and tail, and replaces tool results older than a number of turns with a one-line stub. JSON compaction is not done. Redaction runs first. Nothing it produces is stored.

## §9 The Mac control

A small control in the chat header (Chat feature): provider and model, the cap with presets, a one-line meter `used / limit` with cache reads shown separately, a cold-switch warning ("switching loses the cache: about N tokens on the next turn"), and a one-click raise at the cap. Switch history appears in the agent history view. The Mac chat file mirrors the pin, the limit and the tokens used as optional keys (`routeProvider`, `routeModel`, `routeTokenLimit`, `routeTokensUsed`), also written to the `chat-tags.json` sidecar for an N-1 build, and PUTs them back when the chat opens, which recreates the route purged at quit. The phone sees the route through the Mac; the phone protocol is unchanged.

## §10 Bounds and open items

- The cap is approximate to one reply on both engines. A crash under-counts by at most one turn.
- The cache TTL table (`providers/route-policy.mjs`) carries `source`: Anthropic and OpenRouter are the user's figures, every other provider is `assumed` at ten minutes until a bench run measures it. A wrong TTL changes only when a switch is priced cheap, never whether it is allowed.
- Not built, by decision: automatic switching on warm expiry (Q-R3), extension-side chats (Q-R4), a per-chat cheaper fallback model at the cap.
- Paid bench runs (compression on or off, handoff size, TTL probes, switch cost) are the user's; every default stays as in §2 until they are run.
