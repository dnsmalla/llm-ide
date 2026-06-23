# Slack as an Input Source (Phase 2) — Design

**Date:** 2026-06-23
**Status:** Implemented 2026-06-23 (server 2a + Mac 2b)
**Component:** macOS app (`mac/`) + extension server (`extension/`)
**Builds on:** Phase 1 — `docs/superpowers/specs/2026-06-23-input-source-abstraction-design.md` (the `InputSource`/`SourceRegistry` abstraction).

## Goal

Add Slack as a third input source, following the app's proven **email connector** pattern: a server-side Slack Web API fetcher (bot token in the vault) behind `/kb/slack/{test,fetch,seen}` routes, with a Mac `SlackSource: InputSource` that writes fetched messages into the Library as `platform: "slack"` notes. Forward-only, deterministic, headless-safe.

## Background — why this shape

Investigated alternatives and rejected them on architecture grounds:
- **Slack MCP / agent-driven ingestion:** the app has **no server-side MCP client** and deliberately runs the agent with `--strict-mcp-config` (zero MCP). "Connected MCP servers" is a Claude-client concept, not an app concept. An MCP path would still need a Slack token *plus* an MCP server install on the host *plus* agent-runtime rework, and would be non-deterministic. Not viable/advisable.
- The app's native input pattern is the **email connector** (`extension/agents/email-source.mjs` → `/kb/email/{test,fetch,seen}` → `email_state`/`email_seen` tables → Mac `EmailSource`). Slack mirrors it exactly. Every component below has a working email twin to copy.

## Decisions (from brainstorming)

- **Transport:** Slack Web API with a **bot token** stored in the vault (`slack.botToken`), mirroring `email.imapPassword`. Not MCP, not user OAuth.
- **Content:** user-selected channel(s); forward-only fetch of new messages since a per-channel high-water mark; include thread replies. DMs out of scope (v1).
- **Granularity:** one note **per channel per fetch window** — a transcript of new messages since the high-water mark. Maps onto the existing meeting/email transcript→summary pipeline; avoids per-message flooding. (Per-thread notes are a future refinement.)
- **Server changes are in scope** this phase (unlike Phase 1, which was Mac-only) — a new connector is unavoidable.

## Architecture

```
ConnectionsSettingsSection (Slack card) ──► SlackSourceSheet (token + channels)
        │ test / fetch
        ▼
LlmIdeAPIClient+Slack  ──►  POST /kb/slack/{test,fetch,seen}
        ▼
kb/router.mjs (vault slack.botToken; server high-water)  ──►  agents/slack-source.mjs (Slack Web API)
        ▼ messages
SlackSource.fetchAndIngest (Mac)  ──►  MeetingFileStore note (platform: "slack")
        ▼
SourceRegistry classifies platform "slack" ──► Library SOURCES "Slack" sub-group
```

## Components

### Server (new work) — `extension/`

**`extension/agents/slack-source.mjs`** (twin of `email-source.mjs`)
- `testConnection({ token })` → calls Slack `auth.test`; returns `{ ok, team, user }` or throws.
- `fetchChannelHistory({ token, channelId, oldestTs, limit })` → calls `conversations.history` (and `conversations.replies` for threads), resolves user ids → display names (`users.info`, cached per fetch), returns normalized `{ messages: [{ ts, channelId, user, text, threadTs }], skipped: { overCap } }`. Caps: max messages per fetch (mirror email's 200) and per-message text length (mirror email's 20k).
- Pure helpers (`normalizeMessage`, `stripMrkdwn`) unit-tested. Fixed host `https://slack.com/api/*` (no SSRF surface; no user-supplied host).

**`extension/kb/router.mjs`** — three routes mirroring the email routes:
- `POST /kb/slack/test` — reads `slack.botToken` from vault, calls `testConnection`. Rate-limited in the `dispatch` bucket.
- `POST /kb/slack/fetch` — reads token from vault + server per-channel high-water; calls `fetchChannelHistory` with `oldestTs` = high-water; returns `{ messages, skipped }`. Forward-only (ignores any client-supplied since).
- `POST /kb/slack/seen` — records fetched message ts's + advances per-channel high-water. Local writes (`kbWrite` bucket).
- Add the three paths to the `ENDPOINTS` list in `server.mjs`.

**Migration** `extension/kb/migrations/0017_slack_state.sql` (twin of `0013_email_state.sql`; `0017` = next after the current head `0016` — the plan must confirm the highest existing number in `extension/kb/migrations/` and use the next one):
- `slack_state (user_id, channel_id, last_ts, PRIMARY KEY(user_id, channel_id))` — forward-only high-water per channel.
- `slack_seen (user_id, message_ts, seen_at, PRIMARY KEY(user_id, message_ts))` — dedup ledger.
- `kb/db.mjs` helpers: `getSlackHighWater(userId, channelId)`, `setSlackHighWater(...)`, `getSlackSeenTs(userId)`, `markSlackSeen(userId, ts[])` — twins of the email ones.

### Mac (`mac/`)

**`SlackSource.swift`** (`InputSource`, twin of `EmailSource`)
- `id "slack"`, `displayName "Slack"`, `icon "number"`, `emptyText "No Slack messages yet"`, `platforms ["slack"]`, `mode .fetch`.
- `fetchAndIngest(ctx)`: `guard config.slackSource?.enabled`; for each configured channel call `ctx.api.fetchSlack(...)`; build one transcript note per channel-window via `MeetingFileStore.createPartial(platform: "slack")` → `finalize` → `MeetingSummarizationService.run`; advance high-water via `markSlackSeen`; cap per run; cancellation + drained semantics identical to `EmailSource`. Returns `SourceIngestResult` (incl. `.failure(_, imported:)`).

**`LlmIdeAPIClient+Slack.swift`** (twin of `+Email`): `testSlack(_:)`, `fetchSlack(_:)`, `markSlackSeen(...)`.

**`AppConfig`**: `SavedSlackSource { enabled, channels: [String], lookbackDays }` (twin of `SavedEmailSource`); token never stored locally (vault only).

**`ConnectionsSettingsSection`** + **`SlackSourceSheet.swift`** (twin of `EmailSourceSheet`): a Slack card (configure/test/"Fetch now") + a config sheet (bot token → `setSecret("slack.botToken")`, channel list, lookback). The `.task` auto-fetch loop already drives `SourceRegistry.fetchSources`, so Slack is picked up automatically.

**`SourceRegistry`**: `all = [MeetingSource(), EmailSource(), SlackSource()]`. Remove the `slack` entry from `InputSourceRegistry.planned` (it's now live).

## Data flow

Identical to email: settings card → server fetch (token from vault, forward-only high-water) → Mac writes `platform: "slack"` notes via the meeting pipeline → `SourceRegistry.source(forPlatform: "slack")` classifies them → Library SOURCES shows a "Slack" sub-group. AI summary + `.docx` produced exactly as for meetings/email.

## Error handling

Mirror email: per-fetch errors surfaced on the Slack card; high-water advanced only on a clean drain (no cap/failure/cancellation); `.failure` carries the imported count so the driver rescans only when notes landed; a fetch error that wrote nothing does not rescan. Slack API errors (`auth` failure, `not_in_channel`, rate-limit 429) surface as `.failure` with the Slack error string.

## Testing

- **Server (`npm test`, runs here):** `slack-source.test.mjs` — `normalizeMessage`/`stripMrkdwn` purity, cap enforcement, user-name resolution mapping; router tests for `/kb/slack/{test,fetch,seen}` (mock the Slack fetch) covering forward-only high-water + seen-ledger, twinning the email router tests.
- **Mac (`swift build` local; `swift test` on CI):** `SourceRegistry` already covers `platform "slack" → "slack"` once `SlackSource` is registered — add that case. `SlackSource` ingest logic mirrors `EmailSource` (GUI/integration, build-verified).

## Out of scope

- Slack DMs / private channels beyond what the bot token is invited to.
- Per-thread note granularity (v1 is per-channel-per-fetch).
- Real-time/streaming Slack (Events API) — forward-only polling only.
- **Pagination:** a fetch reads a single `conversations.history` page (newest-first, ≤MAX_MESSAGES, replies combined). If more than that accumulates between polls, the oldest in that window can be missed once the high-water advances. Acceptable for frequent polling; revisit with cursor pagination if high-volume channels need it. `users.info` is resolved per distinct author per fetch (cached within the fetch) — fine at these caps, batchable later if it rate-limits.
- The MCP/agent-driven path (rejected above).
- Two-way Slack (posting) — the existing output webhook is unchanged.
