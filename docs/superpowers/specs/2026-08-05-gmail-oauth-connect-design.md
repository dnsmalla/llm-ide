# Gmail One-Click Connect (hosted OAuth, Testing-mode) — Design

**Date:** 2026-08-05
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/Sources/LlmIdeMac/`) + server (`extension/`)
**Relates to:** [`2026-08-05-slack-oauth-connect-design.md`](2026-08-05-slack-oauth-connect-design.md) (the analogous, already-shipped Slack hosted-OAuth flow — this spec follows the same shape wherever Google's platform constraints allow)

## Goal

Replace today's "create your own Google Cloud OAuth client, paste a Client ID + Secret, then Sign in with Google" setup with a single **"Connect Google"** button: OAuth consent in the browser, done. This is the second of the two originally-planned hosted-OAuth upgrades (Slack shipped first); Box remains a separate, later effort.

**Confirmed with the user before designing:** this is a setup-friction complaint, not a live bug — no error occurs today. Plain email+password login for Gmail is not possible for any third-party app (Google fully disabled "less secure app" password access in 2022); Claude's own Google connectors use this same OAuth consent flow, not raw credentials. OAuth (or a Google-generated App Password) are the only two options Google allows.

## Background — current state

- `agents/google-oauth.mjs` already implements a full PKCE OAuth2 flow (`buildAuthUrl`, `exchangeCode`, `refreshAccessToken`, `fetchEmailAddress`, plus an in-memory single-use state store) — this is the same module the Slack work mirrored the *shape* of, so most of the hard part already exists and works.
- `/auth/google/{start,callback,status}` in `server/auth-routes.mjs` are live routes, but **bring-your-own**: `POST /auth/google/start` requires `{clientId, clientSecret}` in the body, writes them to the per-user vault (`google.email.clientId`, `google.email.clientSecret`), *then* runs the PKCE flow. The callback reads those same per-user vault keys back to exchange the code.
- `EmailSourceSheet.swift` shows a segmented picker — **App password** (paste a Google-generated 16-char app password, no Google Cloud project needed) vs. **Sign in with Google** (requires the user to have already created a Google Cloud OAuth client and pasted its Client ID/Secret into two fields before the "Sign in with Google" button even appears).
- Gmail IMAP access requires OAuth2's `https://mail.google.com/` scope — one of Google's **restricted** scopes. A hosted OAuth app (one client shared across users) requesting this scope needs either full Google verification + a paid CASA security assessment (weeks, ongoing renewal) to remove Google's "unverified app" warning and a 100-user cap, or can run in **Testing** publishing status: free, instant, but capped at 100 manually-added Google test-user accounts (added by the operator in Google Cloud Console) and shows a one-time "unverified app → Advanced → Go to LLM-IDE (unsafe)" click-through during consent. **Decided: Testing mode** — appropriate for LLM-IDE's actual (small/team) user base; revisit if the user base ever grows toward a public product.
- **Critical constraint uncovered during design**: `agents/email-source.mjs`'s `fetchAndIngest` reads `google.email.clientId`/`clientSecret`/`refreshToken` **all from the per-user vault** to call `refreshAccessToken()`. Google requires the *same* OAuth client that minted a refresh token to be used every time that token is refreshed — this is not a preference, a mismatched client_id causes Google to reject the refresh outright. Existing BYO users' refresh tokens are bound to their own Google Cloud client; the hosted flow's refresh tokens are bound to LLM-IDE's own client. Both must keep working.

## Decisions (from brainstorming)

- **Hosted, Testing-mode Google OAuth app.** One Google Cloud project/OAuth client, owned by the operator; client id/secret via server env vars, never per-user. The operator adds each team member's Google account as a Testing-mode test user in Google Cloud Console once (a real, but one-time and free, operational step — different from Slack, where any workspace member could connect with zero pre-registration).
- **Backward compatible by construction, not migration.** Existing BYO users (already have `google.email.clientId`/`clientSecret`/`refreshToken` in their vault) are completely unaffected — their refresh path keeps using their own stored client. Only users with no per-user client stored fall back to the hosted server config.
- **BYO stays available as an "Advanced" fallback** — for a team member past the 100-test-user cap, or who wants an independent Google Cloud project/quota. The entire current sheet (App Password / Sign-in-with-Google picker, with the Client ID/Secret fields) moves, unchanged, under a collapsed "Advanced" disclosure — mirroring exactly how Slack kept its manual bot-token path.
- **Primary UI is a single "Connect Google" button** above the Advanced disclosure, driving the hosted OAuth loopback-and-poll flow — same interaction shape as Slack's "Connect Slack" button and Email's own pre-existing `signInWithGoogle()`.
- **No new vault key.** The hosted flow writes to the *same* `google.email.refreshToken` key BYO already uses — `SourceLinkStore`'s existing `secretKeys(.email)` (`["email.imapPassword", "google.email.refreshToken"]`) already recognizes it with zero changes needed there.

## Architecture

```
Mac: EmailSourceSheet
   │ tap "Connect Google"
   ▼
POST /auth/google/start (authed, empty body — server owns its own OAuth client)
   │  503 CONFIG_MISSING if LLMIDE_GOOGLE_CLIENT_ID/SECRET are unset
   │  mints a PKCE pair + single-use state; resolves the effective
   │  clientId/clientSecret from config (hosted) and stores THEM in the
   │  state entry itself (not the vault) — so the callback uses the exact
   │  same pair that built the authUrl, with no ambiguity and no per-user
   │  vault write for the common (hosted) case
   ▼
authUrl → Mac opens in the default browser → user approves (Testing-mode
          "unverified app" warning appears once — Advanced → Go to
          LLM-IDE (unsafe) — expected, documented in the sheet's hint text)
   ▼
Google redirects → GET /auth/google/callback (existing public route,
          endpoint unchanged) → exchanges the code using the clientId/
          clientSecret carried in the state entry → writes
          google.email.refreshToken (same vault key BYO already uses) →
          fetchEmailAddress(accessToken) to show which Gmail account
          connected
   ▼
completeState/status — unchanged response shape (`{status, email, message}`);
   Mac's existing polling UI already handles this
```

**The BYO path is unchanged in mechanism, just relocated in the UI.** `POST /auth/google/start` still accepts an optional `{clientId, clientSecret}` body: when present, the server treats it as BYO exactly as today (persists them to the per-user vault, resolves the state entry's stored pair from the *request body* instead of server config). When absent, it's the new hosted path. One endpoint, two resolution branches — the callback code path is identical either way (reads clientId/clientSecret from the state entry, never re-derives them).

## Components

**Server (`extension/`):**
- `core/config.mjs` — add `googleClientId`/`googleClientSecret` (`envStr('LLMIDE_GOOGLE_CLIENT_ID')`/`envStr('LLMIDE_GOOGLE_CLIENT_SECRET')`), mirroring `slackClientId`/`slackClientSecret` exactly.
- `agents/google-oauth.mjs` — `putState`'s stored shape gains `clientId`/`clientSecret` (the resolved pair for this flow); no change to `buildAuthUrl`/`exchangeCode`/`refreshAccessToken`'s own signatures.
- `server/auth-routes.mjs` — `POST /auth/google/start`: body's `clientId`/`clientSecret` become **optional**. If provided, BYO (unchanged behavior: persist to per-user vault, use them). If absent, hosted: 503 `CONFIG_MISSING` if server config is unset, else resolve from `config.googleClientId/googleClientSecret`. Either way, store the resolved pair in the state entry. `GET /auth/google/callback`: read `clientId`/`clientSecret` from `getState(state)` instead of re-fetching from the vault by `st.userId`.
- `agents/email-source.mjs` — the refresh-token call site: `getSecret(db, userId, 'google.email.clientId') || config.googleClientId` (and same for `clientSecret`) — per-user vault value wins when present (BYO), hosted config is the fallback (new hosted users, whose per-user client fields were never written).

**Mac (`mac/Sources/LlmIdeMac/`):**
- `Services/API/LlmIdeAPIClient+Email.swift` — add `googleConnectStart() async throws -> GoogleStartResult` (POSTs an empty body to `/auth/google/start`) alongside the existing `googleSignInStart(clientId:clientSecret:)` (unchanged, still used by the Advanced/BYO path). `googleSignInStatus(state:)` is reused unchanged by both.
- `Views/Sources/EmailSourceSheet.swift` — add a primary "Connect Google" button + loopback-poll (same shape as `SlackSourceSheet.connectSlack()`, adapted for `GoogleStartResult`/`GoogleStatusResult`). Relocate the entire existing body (host/port/mailbox fields, the App-Password/Sign-in-with-Google picker, the Client ID/Secret fields) under a collapsed "Advanced" `DisclosureGroup`, unchanged internally.
- `SourceLinkStore.swift` — no change (already recognizes `google.email.refreshToken`).

## Error handling

- **Server not configured**: `POST /auth/google/start` (hosted path, no body) → 503 `CONFIG_MISSING`, sheet shows a clear message and the Advanced/BYO path remains fully usable.
- **User denies consent / cancels**: existing `error=access_denied` handling in the callback is unchanged.
- **Expired / reused state**: existing TTL + single-use handling, unchanged.
- **Refresh-token client mismatch (should never happen by construction, but defensively)**: if `refreshAccessToken` ever fails with `invalid_grant` for a hosted user, that's a signal the server's own `LLMIDE_GOOGLE_CLIENT_ID/SECRET` changed after tokens were minted (e.g., operator rotated the OAuth client) — surfaced as today's existing IMAP-fetch failure path (no new handling needed, but worth a code comment warning against rotating the hosted client casually).
- **Testing-mode consent screen**: not an error, but the sheet's hint text under "Connect Google" should say so explicitly (e.g. "Google will show an 'unverified app' notice the first time — click Advanced → Go to LLM-IDE to continue") so it doesn't read as a bug to a first-time user.

## Testing

- `tests/google-oauth.test.mjs` (extend) — `putState`/`getState` round-trip now carries `clientId`/`clientSecret`.
- `tests/google-oauth-routes.test.mjs` (extend) — new cases: `POST /auth/google/start` with an empty body resolves hosted config and returns 503 when unset (mirrors the Slack unconfigured test, may need its own env-var-isolated file, same reasoning as Slack's `-unconfigured` split); BYO body still persists per-user vault values and behaves exactly as existing tests already assert (regression gate — don't break the current 6+ BYO tests).
- New test proving the `email-source.mjs` refresh call resolves client credentials correctly in both directions: per-user vault value present → used verbatim (BYO, existing behavior); absent → falls back to `config.googleClientId/googleClientSecret` (hosted).
- Mac: no existing XCTest covers `signInWithGoogle()`'s loopback-poll loop (same as Slack's finding) — the new hosted flow is likewise verified manually, not via a new XCTest.
- **Manual verification** (needs a real Google Cloud OAuth client, Testing mode, this session cannot do it): register the client, add test-user Google accounts, set `LLMIDE_GOOGLE_CLIENT_ID/SECRET`, click "Connect Google," click through the Testing-mode warning, confirm the sheet shows "Signed in as ...", confirm a fetch works; separately confirm an *existing* BYO-configured account (if one exists) is completely unaffected.

## Out of scope

- Full Google verification / CASA assessment — revisit only if LLM-IDE's user base grows toward a public product.
- Any change to the Gmail scope or a move from IMAP to the Gmail REST API — IMAP requires the full-mail-access scope regardless; switching protocols is a much larger, unrelated architecture change.
- Box's hosted-OAuth upgrade — separate, later spec.
