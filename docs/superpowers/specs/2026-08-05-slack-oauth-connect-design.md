# Slack One-Click Connect (hosted OAuth, user token) — Design

**Date:** 2026-08-05
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/Sources/LlmIdeMac/`) + server (`extension/`)
**Relates to:** [`2026-08-05-mac-connector-auto-link-design.md`](2026-08-05-mac-connector-auto-link-design.md) (vault-presence badges — `SourceLinkStore` needs to learn the new `slack.userToken` key), [`2026-07-31-slack-connector-engine-design.md`](2026-07-31-slack-connector-engine-design.md) (future ingestion-engine migration — orthogonal; this spec only changes *how the token is acquired*, not the fetch/notes pipeline)

## Goal

Replace today's "paste a Slack bot token you generated yourself, then manually type comma-separated channel IDs, then invite the bot to each one" setup with a single **"Connect Slack"** button: OAuth consent in the browser, then a checklist of channels the user already belongs to — closer to how Claude.ai's own connectors work. This is the first of three planned connector sub-projects (Slack → Box → Email/Google); each ships independently.

## Background — current state

- `SlackSourceSheet.swift` has one field for a bot token (`slack.botToken` in the vault) and a free-text comma-separated `channels` field. The user must create their own Slack App + Bot Token in Slack's developer console, then manually invite the bot into every channel they want fetched (`friendlyError('not_in_channel')` in `agents/slack-source.mjs` exists specifically for this failure).
- `agents/slack-source.mjs` is a thin Slack Web API wrapper (`conversations.history`, `conversations.replies`, `users.list`, `users.info`, `auth.test`) that authenticates with a Bearer token — it does not care whether the token is a bot token (`xoxb-`) or a user token (`xoxp-`); both work identically against these endpoints given matching scopes.
- Email already has a working (if BYO) OAuth flow to mirror: `agents/google-oauth.mjs` (PKCE, state store) + `/auth/google/{start,callback,status}` in `server/auth-routes.mjs`. Google's flow is bring-your-own — the user supplies their own OAuth client id/secret, persisted per-user in the vault before `/auth/google/start`. Slack's flow (this spec) is hosted — LLM-IDE owns one Slack App registration; the client id/secret live in server env vars, never per-user, never on the wire to the Mac.
- `server/vault.mjs` `ALLOWED_KEYS` already includes `slack.botToken`; it needs a new `slack.userToken` key.
- The `2026-07-31-slack-connector-engine-design.md` spec (manifest + adapter engine, `configFields` with a `channels: stringList` field) is drafted but not yet implemented for Slack (no `SlackConnectorAdapter.swift` exists; `SlackSourceSheet.swift` is still the live, bespoke UI). This spec builds on the current bespoke sheet, not the future manifest engine — if/when that migration happens, its `channels` field would simply be pre-populated from OAuth-discovered channels instead of user-typed.

## Decisions (from brainstorming)

- **What "easy" means:** one-click OAuth with no pasted secrets — not a UI-picker redesign (that's the separate, already-shipped `SourceLinkStore` badge work).
- **First sub-project: Slack.** Most standardized OAuth of the three candidate providers (Slack, Box, Email/Google); a clean template for the other two.
- **User-token OAuth, not bot-token OAuth.** Closer to Claude.ai's connector model: connects as the individual user, reads channels/groups they're already a member of. No bot, no per-channel invite step. This changes the vault key (`slack.userToken`, new) and the OAuth scope request (`user_scope` only, no `scope`), but the existing fetch code in `agents/slack-source.mjs` needs no changes — it's already token-shape-agnostic.
- **Auto-discover channels.** Since a user token exposes `users.conversations`, replace the manual channel-ID text field with a checklist of channels the user already belongs to.
- **Backward compatibility:** existing users with a stored `slack.botToken` keep working unmodified — the fetch caller resolves `slack.userToken` first, falling back to `slack.botToken`. The manual-token field isn't deleted, just demoted to a collapsed "Advanced: paste a token manually" disclosure (for a workspace that blocks new app installs).

## Architecture

```
Mac: SlackSourceSheet
   │ tap "Connect Slack"
   ▼
POST /auth/slack/start (authed, no body — server owns its own Slack App credentials)
   │  mints a single-use CSRF state token, builds the Slack OAuth v2 authorize URL
   │  (user_scope only: channels:history,groups:history,channels:read,groups:read,users:read
   │   — no bot `scope`, so no bot user is installed)
   ▼
authUrl → Mac opens in the default browser → user approves on Slack's own consent screen
   ▼
Slack redirects → GET /auth/slack/callback?code=...&state=... (public route, mirrors /auth/google/callback)
   │  exchanges code via oauth.v2.access using the SERVER's client_id/secret (env var, never the vault)
   │  → authed_user.access_token (xoxp-...) stored as vault key slack.userToken
   │  → calls listUserConversations() to prefetch the channel list
   ▼
completeState(state, { status:'complete', channels:[{id,name}, ...] })
   ▼
Mac polls GET /auth/slack/status?state=... (same shape as googleSignInStatus)
   │  on complete: shows a checklist of channels; user checks which to pull from
   ▼
config.slackSource.channels = [selected channel IDs]   (existing local storage, unchanged)
SourceLinkStore.refresh() → badge flips to Connected ✓  (secretKeys(.slack) gains "slack.userToken")
```

## Components

**Server (`extension/`):**
- `agents/slack-oauth.mjs` (new) — pure functions mirroring `agents/google-oauth.mjs`: `buildAuthUrl({clientId, redirectUri, state, userScope})`, `exchangeCode({clientId, clientSecret, code, redirectUri})` (POSTs `oauth.v2.access`, returns `{accessToken, team}`), plus its own in-memory state store (`putState`/`getState`/`completeState`/`takeStatus` — same TTL/single-use shape as Google's; no PKCE verifier, since Slack's v2 authorization code flow doesn't use it).
- `server/auth-routes.mjs` — three new routes alongside the existing Google ones:
  - `POST /auth/slack/start` (authed, no body) — 503 `CONFIG_MISSING` if `config.slackClientId`/`slackClientSecret` are unset; otherwise mints state + returns `{authUrl, state}`.
  - `GET /auth/slack/callback` (public — add to `server/auth.mjs` `PUBLIC_PATHS`) — exchanges the code, stores `slack.userToken` in the vault, calls `listUserConversations()`, completes the state with the channel list. Errors (denied consent, expired/reused state, exchange failure) mirror the existing Google callback's handling, redacting the client secret from any surfaced message.
  - `GET /auth/slack/status?state=...` (authed poll) — same contract shape as `/auth/google/status`.
- `core/config.mjs` — add `slackClientId`/`slackClientSecret` (`envStr`, optional; `LLMIDE_SLACK_CLIENT_ID`/`LLMIDE_SLACK_CLIENT_SECRET`). Never hardcoded, never in the vault.
- `server/vault.mjs` — add `'slack.userToken'` to `ALLOWED_KEYS`. `slack.botToken` stays for backward compatibility.
- `agents/slack-source.mjs` — add `listUserConversations({token})`: paginated `users.conversations` (`types=public_channel,private_channel`, `exclude_archived=true`), capped pagination like the existing `users.list` roster fetch. `fetchChannelHistory`/`testConnection` need no changes (already Bearer-token-agnostic). Generalize the `invalid_auth`/`token_revoked` error copy from "check the bot token" to "check your Slack connection".
- `kb/router.mjs` — add `GET /kb/slack/conversations` (authed) for a "Refresh channels" action independent of the OAuth flow, resolving whichever token (`slack.userToken` else `slack.botToken`) is stored.
- Per the invariants doc: add both new endpoints to `server.mjs`'s `ENDPOINTS` array and bump `SERVER_API_VERSION`. No `REQUIRED_ENDPOINTS` change in `src/sidepanel/App.tsx` — that list is a curated core-feature set and doesn't track any `/auth/*` route today.

**Mac (`mac/Sources/LlmIdeMac/`):**
- `Views/Sources/SlackSourceSheet.swift` — replace the token-paste field with a "Connect Slack" button using the same loopback-poll loop shape as `EmailSourceSheet.signInWithGoogle()`; replace the comma-separated `channelsText` field with a checklist bound to a `Set<String>` of checked channel IDs, populated from the OAuth completion payload (or a manual "Refresh channels" tap). Keep the old token field behind a collapsed "Advanced: paste a token manually" disclosure, writing to `slack.botToken`.
- `Services/API/LlmIdeAPIClient+Slack.swift` — three thin wrappers: `slackConnectStart() async throws -> (authUrl: String, state: String)`, `slackConnectStatus(state:) async throws -> SlackConnectStatus` (mirrors `googleSignInStatus`), `fetchSlackConversations() async throws -> [(id: String, name: String)]`.
- `Services/SourceLinkStore.swift` — `secretKeys(.slack)` gains `"slack.userToken"` alongside the existing `"slack.botToken"` (either present ⇒ linked — matches Email's existing multi-key pattern for `email.imapPassword`/`google.email.refreshToken`).

## Error handling

- **Server not configured** (`LLMIDE_SLACK_CLIENT_ID/SECRET` unset): `/auth/slack/start` → 503, sheet shows a clear "Slack connect isn't set up on this server yet" message rather than a generic failure.
- **User cancels consent** (Slack redirects with `error=access_denied`): callback completes the state as `{status:'error', message:'Sign-in cancelled.'}`, same as the Google callback.
- **Expired or reused state** (10-min TTL, single-use `takeStatus`): "This sign-in link has expired/already been used — start again," same copy pattern as Google.
- **Token exchange failure**: error message passed through the existing secret-redaction helper so the client secret can never appear in a surfaced error string.
- **Channel discovery fails after a successful token exchange** (e.g. transient Slack outage): does not fail the connect — the token is stored and the badge goes Connected; the sheet shows an empty checklist with a "Couldn't load channels — Refresh" action wired to `GET /kb/slack/conversations`. Mirrors `SourceLinkStore`'s existing `lastRefreshFailed` fail-soft pattern.
- **Token later revoked** (user revokes the app from their Slack account settings): the existing `friendlyError('invalid_auth'|'token_revoked')` path in `slack-source.mjs` already surfaces this on the next fetch attempt; only the message copy changes.
- **`users.conversations` pagination**: bounded the same way as the existing `users.list` roster fetch, so a very large workspace can't hang the callback.

## Testing

- `tests/slack-oauth.test.mjs` (new, mirrors `tests/google-oauth.test.mjs`): `buildAuthUrl()` scope/shape, `exchangeCode()` success + failure parsing, state store TTL + single-use.
- `tests/slack-oauth-routes.test.mjs` (new, mirrors `tests/google-oauth-routes.test.mjs`): `POST /auth/slack/start` happy path + 503 when unconfigured; `GET /auth/slack/callback` happy path, `access_denied`, expired state, reused state; asserts the response to the Mac never contains a secret value, only presence/status.
- `tests/slack-source.test.mjs` (extend): `listUserConversations()` pagination, mirroring the existing `getTeamRoster` pagination tests.
- Mac: no existing XCTest covers the analogous `signInWithGoogle()` loopback-poll loop, so none is added here for parity — verified manually (Connect → consent → channel checklist appears → Fetch works), same as the just-shipped `SourceLinkStore` spec's manual criterion.

## Out of scope (this sub-project)

- Box and Email/Google hosted-OAuth upgrades — separate specs, once this one ships and proves the pattern.
- Migrating Slack onto the `SourceConnectorManifest` engine (`2026-07-31-slack-connector-engine-design.md`) — orthogonal; can happen later against whichever token key is present.
- DM/multi-person-DM history (`im:history`/`mpim:history` scopes) — channel-only for v1, matching today's scope.
- Auto-selecting "all channels the user is in" without a checklist — the checklist step is kept so fetch volume stays deliberate, matching today's explicit channel-ID entry.
