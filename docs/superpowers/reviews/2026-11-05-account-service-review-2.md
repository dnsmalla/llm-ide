# Account service and public site review, round 2 (2026-11-05)

Independent review of the work committed after the [first review](2026-11-05-account-service-review.md): account-service, desktop sign-in and the account pages (`6d64d311`..`0dc21dcd`), and the public site with the web app at `/app` (`17635c34`, `77e5df3e`, `2ca46173`, `d72b4324`). Uncommitted `marketing/` edits were not reviewed.

## Resolution (2026-11-05, later the same day)

All Critical and Important findings of both reviews are fixed, each with a test that failed before the fix, and each batch re-reviewed adversarially: N2 (`ec20eae0`, plus the in-flight verify race `18fbc09d`), N1 (`c53e3cce`), C1 (`37d659a1`), I3 (`9399b64d`), I1 (`ab3a74f5`), I2 (`b9087a76`). The batch-B review's two follow-ups (a revoked desktop re-registering with its old token; a silent authorize leading to replace) are closed by `ab3a74f5` and `b9087a76`. `account-service` tests 91/91. Still open: deploying to the VPS (the live build predates these fixes), the export/delete buttons on the account pages, the site overclaims and deploy/header items below, and the Minor items in the per-batch reviews.

## Do first (as written before the fixes)

1. **Switch off direct sign-up on the VPS now** (`ACCOUNTS_DIRECT_SIGNUP=1`; `https://accounts.llm-ide.com/health` reports `directSignup: true`). With it on, **N2 is an account takeover on the live service**.
2. Fix N2, C1, I3, I1, I2, N1 in that order, each with a test that fails before the fix.
3. Correct the marketing overclaims below before the site is promoted.

## Status of the first review at HEAD

- **C1 not fixed:** desktop sign-in still always fails (`desktop/src-tauri/src/account_oauth.rs:182-185` Bearer vs cookie-only `account-service/src/routes/account.mjs:9-11`); so register-desktop and revoke-on-sign-out never run in a real build.
- **I1 not fixed:** recovery revokes only web sessions (`passkeys.mjs:76-79`); `DELETE /v1/devices/:id` also leaves that desktop's tokens live.
- **I2 not fixed:** no OAuth consent step (`routes/oauth.mjs:30-35`).
- **I3 not fixed, now worse:** `devices.mjs:25` counts revoked rows, so after one revoke `POST /v1/desktop` is 409 forever; keys are checked only as ASCII text (`validate.mjs:53-58`), no proof of possession; no 72 h hold.
- **I4 fixed** on the server (family revoke) and in the desktop (revoke before local delete), unreachable until C1 is fixed.

## New findings (account service)

- **N2 (Important, account takeover while direct sign-up is on):** direct sign-up reuses a pending account row and hands out a fresh setup session (`signup.mjs:27-30`); the passkey routes accept any live setup session without checking the account is still pending (`passkeys.mjs:5-9`); activation revokes only the registering session (`passkeys.mjs:80`). An attacker who starts a sign-up for `victim@x` and keeps the cookie can add their own passkey after the victim activates, with no email and no fresh proof, then mint desktop tokens, register their desktop first (locking the victim out, I3) or delete the account. Fix: refuse passkey registration through a setup session once the account is active, revoke all setup sessions on activation, and never let direct sign-up take over an existing pending row.
- **N1 (Important):** direct sign-up has no proof of email ownership and bypasses `signupOpen` (`signup.mjs:12-41`); `409 account_exists` enumerates accounts; the only limit is 10/hour per IP (IPv6 rotation defeats it). Fix: off in production, or an allowlist of named addresses; same answer whether the account exists; limit per IPv6 /64.

Tests at HEAD: `account-service` 67/67, `cargo test account` 4/4 (unused import warning `tauri::Emitter`).

## Public site and `/app`

Web tests 76/76; the app's CSP is not loosened; no third-party scripts, fonts or analytics (UN-061); the marketing pages cannot reach the Host API or the `__Host-` account cookie; `/app` paths and service-worker scope are correct.

- **Important, privacy claim:** `marketing/privacy.html` section 6 says export and delete are available "from the account pages". The API has them (`GET /v1/account/export`, `POST /v1/account/delete`) but `account-service/public/app.js` has no UI for them. Add the buttons or reword.
- **Important, deploy:** nothing sets `VITE_BASE=/app/` (`web/vite.config.ts:29` defaults to `/`), and `web/scripts/serve.mjs` serves only `dist/` at `/`: it does not serve `marketing/`, and under `/app/` hashed assets lose immutable caching and its `/assets/` 404 checks stop matching.
- **Important, headers:** no committed config gives the marketing pages CSP, `frame-ancestors`/`X-Frame-Options`, nosniff or HSTS; they use inline `style=` (needs `style-src 'unsafe-inline'` or removal).
- **Important, tour accessibility:** `marketing/site.js:73-76` reacts to every ArrowLeft/ArrowRight with no focus guard; no `aria-live` for step changes.
- **Overclaims to correct:** the relay ("encrypted envelopes", "the cloud remains blind") is presented as built in `how-it-works.html` and `security.html` but is sub-project 3, not started; "Desktop approves every device" (`how-it-works.html`, `why.html`) is not built; public sign-up is promoted everywhere though it is a launch gate; `pricing.html` makes a plan-change commitment with no recorded pricing decision; Explorer, Terminal, Doc Gen and Gantt are Mac-app features and the pages do not say today's app is macOS only (Windows and Linux builds are CI-only and unsigned; "Windows Hello" in `guide.html`); `guide.html` "host address is prefilled" is unconfirmed; the web pairing copy (`17635c34`) overstates the web client (pairing, chat, approvals, read views off by default).
- **Legal pages** (privacy, terms, cookies, acceptable use) need lawyer review before launch (spec launch gate); privacy names no infrastructure or email provider, and none is chosen yet.
