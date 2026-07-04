# Gmail via Google Sign-In (OAuth2 / XOAUTH2) — Design

Date: 2026-07-04
Status: **Designed** (awaiting implementation plan)
Branch: `feat/email-google-oauth`

## Problem

The Email source authenticates to IMAP with a password. For Gmail this means an **App Password**, which requires 2-Step Verification and is disabled entirely by some accounts/Workspace policies — so a correct app password can still be rejected (`IMAP login failed`), leaving the user with no working path. The user wants **"Sign in with Google"** (browser OAuth, using their existing Chrome Google session) instead.

A true zero-setup "Sign in with Google" (like Apple Mail) requires Google **OAuth verification + CASA** because Gmail IMAP needs the *restricted* `https://mail.google.com/` scope — infeasible for a self-hosted app, and it would ship a client secret. The feasible version for a self-hosted tool is **bring-your-own OAuth client**: the user creates a Google Cloud OAuth client once and adds themselves as a test user (no verification needed for personal use).

## Decisions (locked with the user)

1. **Add Google Sign-In as an alternative auth method; keep App Password.** `SavedEmailSource.authMethod` ∈ `password` (default, unchanged) | `google`. Non-breaking.
2. **Bring-your-own OAuth client.** The user pastes their Google Cloud OAuth *Desktop-app* client ID + secret. No shipped/shared app, no verification.
3. **Loopback redirect through the existing backend** (`http://127.0.0.1:3456/auth/google/callback`) — Google Desktop clients support loopback; reuses the running server, no custom URL scheme needed.
4. **PKCE + state.** The flow uses PKCE (`code_challenge`/`verifier`) and a `state` nonce; the callback is public (browser GET, no JWT), tied to the initiating user via `state`.
5. **Tokens in the vault.** `google.email.clientId`, `google.email.clientSecret`, `google.email.refreshToken`. IMAP uses a fresh access token via XOAUTH2 (`imapflow auth: { user, accessToken }`).

## Architecture

```
Mac EmailSheet (authMethod=google)
  ├─ paste clientId + clientSecret
  └─ "Sign in with Google"
        │ POST /auth/google/start   (authed: has userId)
        ▼
  server: persist clientId/secret to vault; make PKCE verifier + state;
          store {state → userId, verifier, status:'pending'} in-memory (TTL 10m);
          return { authUrl, state }
        │
  Mac opens authUrl in the browser (NSWorkspace.open)
        │  user consents (Chrome Google session; scope mail.google.com; access_type=offline; prompt=consent)
        ▼
  Google → GET http://127.0.0.1:3456/auth/google/callback?code&state   (PUBLIC, browser)
        │  look up state→userId+verifier; read client creds from vault;
        │  exchange code(+verifier) → { access_token, refresh_token };
        │  store refresh_token in vault; set state entry status:'complete', email
        ▼  render "Signed in — you can close this tab."
  Mac polls GET /auth/google/status?state  (authed) → {status, email}
        │  on 'complete': save SavedEmailSource(authMethod:.google, user:email)
        ▼
  Email fetch: connector gets fresh access_token (refresh via Google token endpoint,
               cached with expiry), authenticates IMAP with XOAUTH2.
```

Single-node in-memory `state` store is acceptable (matches the existing rate-limit/breaker maps; self-hosted, localhost).

## Components

### Backend
1. **`extension/agents/google-oauth.mjs` (new)** — pure-ish helper, network via global fetch (fixed host `oauth2.googleapis.com` / `accounts.google.com`, no SSRF surface):
   - `pkcePair()` → `{ verifier, challenge }` (S256; `crypto`).
   - `buildAuthUrl({ clientId, redirectUri, state, challenge })` → the `accounts.google.com/o/oauth2/v2/auth?...` URL (scope `https://mail.google.com/`, `access_type=offline`, `prompt=consent`, `response_type=code`, `code_challenge_method=S256`).
   - `exchangeCode({ clientId, clientSecret, code, verifier, redirectUri })` → `{ accessToken, refreshToken, expiresIn }` (POST token endpoint).
   - `refreshAccessToken({ clientId, clientSecret, refreshToken })` → `{ accessToken, expiresIn }`.
   - `fetchEmailAddress(accessToken)` → the account email (userinfo/profile) for display + IMAP username.
2. **State store** (in `google-oauth.mjs` or a small module): `putState(state, {userId, verifier})`, `getState(state)`, `completeState(state, {email})`, `takeStatus(state)` — Map with a 10-minute TTL sweep. Never stores client secret (read from vault in the callback).
3. **Routes** (`extension/server/auth-routes.mjs` + `isAuthRoute` + `server.mjs` ENDPOINTS + openapi + api-server.md):
   - `POST /auth/google/start` (**authed**): body `{clientId, clientSecret}`; persist creds to vault; create state+PKCE; return `{authUrl, state}`.
   - `GET /auth/google/callback` (**public** — add to a public branch of `handleAuth`, no token): read `code`+`state`; look up state→userId; read client creds from vault; `exchangeCode`; store `refreshToken` in vault; mark state complete + capture email; respond with a minimal self-closing HTML page. On error, an HTML error page (no secret echoed; redactWithKey).
   - `GET /auth/google/status?state=` (**authed**): return `{status: pending|complete|error, email?, message?}` for the caller's own state.
   - Add `google.email.clientId/clientSecret/refreshToken` to vault `ALLOWED_KEYS`.
4. **Email connector (`extension/agents/email-source.mjs`)**: `makeClient` accepts either `{password}` or `{accessToken}`; when `accessToken` present, use `auth: { user, accessToken }` (XOAUTH2). Add a `getGoogleAccessToken(userId)` path: read refresh token + client creds from vault → `refreshAccessToken` → return access token. The `/kb/email/test` + `/kb/email/fetch` routes: when the source's `authMethod === 'google'`, obtain an access token instead of the IMAP password. (Route learns authMethod from the request body / saved source.)

### Mac (`mac/Sources/LlmIdeMac/`)
5. **`SavedEmailSource.authMethod: String = "password"`** (tolerant-decode default; `"password"` | `"google"`).
6. **`EmailSourceSheet`**: an auth-method **Picker** (App Password | Google Sign-In). Google mode shows clientId + clientSecret fields + a **"Sign in with Google"** button:
   - calls `api.googleSignInStart(clientId, clientSecret)` → `{authUrl, state}`, `NSWorkspace.shared.open(authUrl)`, then polls `api.googleSignInStatus(state)` (~2s interval, ~3m timeout) → on `complete`, set `draft.authMethod = "google"`, `draft.user = email`, save `SavedEmailSource`.
7. **`LlmIdeAPIClient+Email.swift`**: `googleSignInStart`, `googleSignInStatus`.

## Error handling
- Callback/exchange failures render an HTML error page and set state `status:'error'` with a redacted message (`redactWithKey` with the client secret) — the client secret is never echoed to the browser or logs.
- Expired/invalid refresh token at fetch time → the connector surfaces "Google sign-in expired — sign in again" (distinct from IMAP password errors), so the user re-runs the flow.
- State TTL expiry / unknown state → status `error` "sign-in timed out, try again".
- Scope/consent denied → Google redirects with `error=access_denied`; callback renders "sign-in cancelled".

## Testing
- `google-oauth.mjs`: `pkcePair` (challenge is S256(verifier), URL-safe), `buildAuthUrl` (has state/challenge/scope/offline/consent), `exchangeCode` + `refreshAccessToken` against a mocked token endpoint (global.fetch stub), token-error surfacing. State store put/get/complete/expiry.
- Routes: `/auth/google/start` requires auth + persists creds + returns authUrl/state; `/auth/google/callback` (public) exchanges + stores refresh token + marks complete (mock Google); `/auth/google/status` reflects state; secret never in the response/log (assert).
- `email-source.mjs`: `makeClient` uses XOAUTH2 when given `accessToken`; `getGoogleAccessToken` refreshes via the mocked endpoint.
- Mac: `SavedEmailSource.authMethod` persistence + tolerant decode (old configs default to `password`).
- Full mac + ext suites green; docs-check green.

## Security
- Client secret + refresh token live only in the encrypted vault (never AppConfig/UserDefaults/logs); redaction via `redactWithKey`.
- PKCE (S256) + `state` nonce prevent auth-code interception/CSRF on the public loopback callback.
- Callback bound to loopback (`127.0.0.1`), fixed Google hosts (no SSRF surface). State single-use, 10-min TTL.
- `mail.google.com` is a restricted scope: the user runs their own client in **test-user** mode (documented setup) — no shared secret, no verification burden on us.

## Out of scope
- A shared/verified Google app (zero-setup sign-in) — needs OAuth verification + CASA.
- OAuth for non-Gmail IMAP providers, and Gmail API (we use IMAP+XOAUTH2, not the REST API).
- Removing the App Password method (kept as-is).

## User setup (one-time, will ship as in-sheet help + a doc)
Google Cloud console → new project → OAuth consent screen (External, add your email as a **test user**) → Credentials → Create OAuth client ID → **Desktop app** → copy client ID + secret → paste into the Email sheet's Google Sign-In fields. Enable IMAP in Gmail.
