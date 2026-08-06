# Model Usage Limits & Auto-Fallback — Design

Date: 2026-06-26
Status: **Implemented & merged to `main`** (see "Implementation status" at the end)
Branch: `feat/model-usage-limits` (merged)

## Problem

The user runs Auto Tasks (and chat / code review) against AI models that have
usage limits — either a logged-in CLI subscription (claude/codex/gemini) with an
opaque usage window, or an API key with a spend budget. Today nothing tracks
usage or reacts to limits: a run either succeeds or fails on a raw 429/quota
error, and there is no way to keep work flowing by switching to another model.

The user wants to control all model usage themselves, with an experience modeled
on Claude's own settings: a live usage dashboard, user-set caps, and visible
auto-switch status. When the active model is "almost finished", work should
automatically continue on another model; when everything is exhausted, it should
pause until the limit resets.

## Decisions (locked with the user)

1. **Limit type** — Both: a configurable usage budget AND live reaction to
   429/quota errors.
2. **Fallback scope** — Same provider only. Each provider has its own ordered
   chain (e.g. Anthropic: Opus → Sonnet → Haiku). Providers are never switched
   automatically.
3. **Detection** — Both proactive (track usage vs. budget) and reactive (switch
   on live quota errors).
4. **Budget unit** — Per model. Each model in a chain has its own limit,
   expressed as **runs** or **tokens**, with a configurable window.
5. **Scope** — All model usage (global). The backend is the single source of
   truth so chat, code review, and Auto Tasks all count against the same budgets.
6. **Chain exhausted** — When every model in a provider's chain is exhausted,
   **pause** that provider until the window resets (never silently overrun).
7. **Window** — Fixed reset (daily at local midnight, or monthly on day 1).
8. **Claude-like UX** — All three facets: usage dashboard, user-set caps, and
   auto-switch status/transparency.
9. **Placement** — The "Model & Limits" item on the Auto Tasks page.

## Architecture

The Node backend (`extension/`) is the source of truth. It already owns a
sqlite DB (see `extension/kb/migrations/`, e.g. `0009_rate_limit_state.sql`) and
the model dispatch layer (`extension/agents/runtime.mjs` → `providers.mjs`),
which already detects non-transient quota errors (`providers.mjs:169`). We add a
usage ledger, a limits config store, and a resolver there.

The SwiftUI app (`mac/`) is a client: it edits limits and reads live meters over
HTTP. Critically, the Auto Tasks path
(`mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`) spawns CLIs
directly and bypasses the backend today — so it must start (a) asking the backend
which model to use and (b) reporting each run into the ledger, so global usage
stays honest.

```
                    ┌──────────────────────────────────────────┐
   chat / review ──▶│  Node backend (source of truth)           │
   /code-assist     │  runClaude() / providers.mjs              │
                    │    • resolveModel(provider) ──┐            │
                    │    • record usage  ◀──────────┘            │
                    │  sqlite: usage_ledger, model_limits,      │
                    │          quota_state                       │
   Auto Tasks ─────▶│  GET  /kb/usage/resolve  (which model?)   │
   (Swift CLI)      │  POST /kb/usage/record   (1 run done)     │
                    └──────────────────────────────────────────┘
                              ▲ GET/PUT /kb/usage/limits
                              ▲ GET     /kb/usage/summary (meters)
                    ┌─────────┴──────────────────────────────────┐
                    │  Swift: Auto Tasks ▸ "Model & Limits" panel │
                    └─────────────────────────────────────────────┘
```

## Data model (new sqlite migration)

### `usage_ledger` (append-only events)
- `id` PK, `ts` (UTC), `provider`, `model`
- `source` — `'api' | 'cli' | 'auto-task'`
- `endpoint` — e.g. `/code-assist`, `/chat`, `auto-task:reviewCode`
- `input_tokens`, `output_tokens` — nullable (CLI/subscription can't report them)
- `runs` — integer, default 1
- `user_id`, `request_id` — nullable, for correlation
- Index on `(provider, model, ts)` for window aggregation.

### `model_limits` (config — source of truth)
- `provider`, `model`, `priority` (chain order), `enabled`
- `limit_value` (integer), `unit` — `'runs' | 'tokens'`
- `window` — `'daily' | 'monthly'`
- `threshold_pct` — integer, default 90 (proactive switch point)
- `updated_at`
- PK `(provider, model)`.
- Seeded defaults:
  - anthropic: `claude-opus-4-8` → `claude-sonnet-4-6` → `claude-haiku-4-5-20251001`
  - openai: `gpt-4o` → `gpt-4o-mini` → `o3-mini`
  - google: `gemini-2.0-flash` → `gemini-1.5-pro` → `gemini-1.5-flash`
  - (custom: empty until the user adds models)

### `quota_state` (reactive flags)
- `provider`, `model`, `window_start`, `exhausted`, `hit_at`
- PK `(provider, model, window_start)`.
- Set when a non-transient 429/quota error fires; ignored once `window_start`
  no longer matches the current window (natural expiry).

## Window math

Window boundaries and ledger timestamps must be compared in the **same
timezone**. `usage_ledger.ts` and `windowStart`/`resetAt` are all computed in the
server's local timezone (the boundary is what the user perceives as "midnight"
or "the 1st"); store timestamps as ISO-8601 local so the `ts >= windowStart`
comparison is apples-to-apples.

`windowStart(window, now)`:
- `daily` → local midnight of today.
- `monthly` → first day of the current month, local.

`resetAt(window, now)` → next boundary. Used for "resets in 4h / on Jul 1".

Usage for a model = aggregate over `usage_ledger` where `ts >= windowStart`:
- unit `runs` → `SUM(runs)`
- unit `tokens` → `SUM(input_tokens + output_tokens)` (rows with null tokens
  contribute 0 tokens; they still count as runs for run-based limits).

## Resolution logic (`resolveModel(provider, now)`)

Walk the provider's enabled chain in `priority` order:
1. **Primary** — return the first model with `usage < threshold_pct%` of its
   limit and no `quota_state.exhausted` for the current window. *(Proactive:
   this is "almost finished → use another".)*
2. **Degraded** — if all are past threshold, return the first still under 100%
   (and not quota-flagged).
3. **Paused** — if all are ≥100% or quota-flagged, return
   `{ status: 'paused', resetAt }`.

Returns `{ model, provider, status: 'ok' | 'degraded' | 'paused', resetAt, reason }`
where `reason` powers the auto-switch status line (e.g. "Opus 92% used →
Sonnet").

Reactive path: on a non-transient quota error during dispatch, write
`quota_state.exhausted = 1` for that model+window, then immediately retry with
the next chain entry (or pause if none).

## Backend dispatch changes

- `runtime.mjs` / `providers.mjs`: when the caller has **not** pinned a specific
  model, call `resolveModel(provider)` to choose; honor `paused` by surfacing a
  clear error / skip.
- After every call, **record usage** into `usage_ledger`. Extract tokens from
  Anthropic (already logged at `runtime.mjs:208`) AND from OpenAI/Google
  responses (currently parsed for text but usage discarded — capture it).
- Wrap the existing quota detection to also write `quota_state` and trigger the
  reactive retry.

## HTTP endpoints (new)

Wired in `extension/route.mjs` and registered in `extension/registry.mjs`
(`GLOBAL_HANDLED`), consistent with how other `/kb/*` routes are added.

- `GET  /kb/usage/limits` — chains + per-model limits + global behavior.
- `PUT  /kb/usage/limits` — save chain order + per-model caps.
- `GET  /kb/usage/summary` — per-model current-window usage, %, status, resetAt
  (drives the dashboard meters and the auto-switch status line).
- `GET  /kb/usage/resolve?provider=` — resolved model + status (used by the
  Swift Auto Tasks path; also callable internally).
- `POST /kb/usage/record` — record a usage event (used by the Swift CLI path).

## Swift Auto Tasks CLI path

In `AutoCodeUpdateService`:
- **Before** each CLI run: `GET /kb/usage/resolve?provider=<active>` to pick the
  model. If `paused`, skip the run and show a banner ("All <provider> models
  exhausted — resets <when>"). Otherwise pass the resolved model id to the CLI.
- **After** each run: `POST /kb/usage/record` with
  `{ provider, model, source: 'auto-task', runs: 1, endpoint: 'auto-task:<task>' }`.
  Tokens are null (CLI can't report them) — these count toward run-based limits.

## UI — "Model & Limits" on the Auto Tasks page

Add a new row below **Knowledge** in the left list of
`mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`
(icon `gauge.with.dots.needle`). It is a config surface, not a runnable
`AutoTask`, so the view's selection state changes from `AutoTask?` to a small
wrapper enum so the right pane can render either a task editor or this panel:

```swift
enum AutoCodeSelection: Hashable {
    case task(AutoTask)
    case modelLimits
}
```

Right-pane panel (modeled on Claude's settings), three facets:

1. **Usage dashboard** — per model in the active provider's chain: a progress
   bar (green < threshold, amber ≥ threshold, red ≥ 100%), `used / limit`
   (runs or tokens), and "resets in 4h / on Jul 1". Refreshes from
   `/kb/usage/summary`.
2. **User-set caps** — per-model editable rows: enable toggle, reorder
   (priority), limit value field, unit picker (Runs/Tokens), window picker
   (Daily/Monthly), threshold % stepper (default 90). Save → `PUT /kb/usage/limits`.
3. **Auto-switch status** — a banner showing the currently active model and why
   (e.g. "Opus paused — 92% used · now on Sonnet · resets in 4h"), from the
   resolver's `reason`/`status`.
- A footer line: "When all models are exhausted: Pause until reset."
- A provider picker at the top (defaults to the active provider) so the user can
  view/edit each provider's chain.

This reuses the page's existing left-list / right-detail pattern, so it feels
native.

## Implementation phases

1. **Backend foundation** — migration (3 tables + seed), a usage db module
   (window math, aggregation, record, resolve, quota flagging), unit-tested in
   isolation.
2. **Dispatch integration + endpoints** — hook recording + resolution into
   `runtime.mjs`/`providers.mjs`; add the 5 `/kb/usage/*` routes.
3. **Swift CLI participation** — `AutoCodeUpdateService` resolves before / records
   after each run; pause handling + banner; API client methods.
4. **Swift UI panel** — the "Model & Limits" item + three-facet panel with live
   meters and caps editing.

## Out of scope (YAGNI)

- Cross-provider automatic fallback (explicitly same-provider only).
- Per-user / multi-tenant budgets (single-user app; `user_id` is recorded for
  future use but not enforced per-user).
- Cost/dollar accounting (track tokens/runs, not money).
- Historical usage charts beyond the current window.

## Risks / notes

- CLI/subscription mode can't report tokens — token-unit limits are only
  meaningful for API mode. The UI should note this and default subscription
  providers to run-based limits.
- Adding `/kb/usage/*` routes requires touching both `route.mjs` and
  `registry.mjs` (`GLOBAL_HANDLED`) per the project's routing convention.
- The migration must follow the existing numbered convention in
  `extension/kb/migrations/` (next free number).

## Implementation status (as-built)

Implemented and merged to `main`. Migration `0019_usage_limits.sql`; store/
resolver `extension/kb/usage.mjs`; routes in `extension/kb/router.mjs`; dispatch
metering in `extension/agents/runtime.mjs` + `providers.mjs`; Swift client
`mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Usage.swift`; UI
`mac/Sources/LlmIdeMac/Views/AutoCode/ModelLimitsPanel.swift`. System docs:
`docs/spec/knowledge-base.md`, `agent-runtime.md`, `macos-app.md`,
`docs/reference/api/openapi.yaml`.

Deltas from the original design (refinements made during build/review):

- **`preferModel` resolution.** `resolveModel` keeps the caller's requested
  model when healthy and steps **down** the chain only when it's constrained —
  it never upgrades past what was asked. The original design always returned the
  chain top.
- **Auto-fallback is on by default and broader than Auto Tasks.** `runClaude`
  `autoFallback` defaults true (gated by `engaged`: a cap or quota flag), so
  chat/review/agent paths auto-switch + pause too — not just Auto Tasks. It
  stays inert until the user configures a cap.
- **In-request reactive retry.** A non-transient 429 in `completeViaApi` flags
  the model and retries the next chain model in the *same* request (the design
  only described next-call avoidance).
- **Multi-provider rate-limit gauge.** Captures Anthropic `anthropic-ratelimit-*`
  and OpenAI `x-ratelimit-*` headers, keyed per (user, provider); surfaced via
  `GET /kb/usage/ratelimits` and the panel's API-rate-limit card. This is the
  closest supportable analog to Claude's subscription view — **real subscription
  usage is not fetchable** (no Anthropic API exposes it).
- **Transparency + retention.** Auto-switches emit a throttled `model_fallback`
  activity event; `usage_ledger` self-prunes to a 90-day window.
- **Routing.** The `/kb/usage/*` routes live inline in `kb/router.mjs`'s
  `handleKB` (not `route.mjs`/`registry.mjs`, which govern the agent skill layer,
  not KB HTTP routes) and are registered in `server.mjs`'s `ENDPOINTS` +
  `openapi.yaml`.

Known limitations (intentional / unfixable): no subscription-usage API; token
caps are runs-only in CLI/subscription mode; windows use server-local time; one
chain per provider (not per Auto Task). See the session review for the full list.
