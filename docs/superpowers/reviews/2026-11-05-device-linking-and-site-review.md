# Device linking v1 and public site review (2026-11-05)

Independent review of device linking v1 (`b893a174`, `c7476c87`, `11b26493`, `448b931a`, `813f9053`; doc [device-linking-v1](../plans/2026-11-05-device-linking-v1.md)) and the web pairing screen and site deep dives (`8a7256bc`, `ff21e051`, `d74e5222`, `c9c82fe5`). Tests at review time: `account-service` 95/95, desktop `cargo test account` 6/6, `web` 76/76, `tsc` clean.

## Device linking v1

**Deployed state:** safe to leave running as an inert demo. Nothing reads a linked device's status, keys or `devices.token_hash` yet (the Host API's own device pairing is separate). **Before the relay or anything else trusts a link**, fix C1, C2, I1, I2 and I3 below, make browser keys non-extractable and persisted, settle the token-hash encoding, and treat every device linked under v1 as unverified (force a re-link, or mark it `unlinked` in a migration).

### Critical

- **C1, the desktop does not keep its own nonce** (`desktop/src-tauri/src/account_oauth.rs:450`, `:421-430`): it discards the nonce it sends on approve and later builds the commitment check and the SAS from values the service returns. A malicious service picks the desktop nonce and its own device keys after seeing everything and grinds about 10^6 SHA-256 hashes (milliseconds) to hit the SAS the user sees: a complete man-in-the-middle that links the service's key as the user's device.
- **C2, the browser computes its SAS from values chosen after it revealed its keys** (`account-service/public/link.js:89-94`, `:71-79`): the browser sends its keys at `approved` and takes the desktop nonce and key from a later status reply. Commit-then-reveal only works when each side computes from values it holds or committed to before the other side's reveal.

### Important

- **I1, the SAS omits the desktop ECDH key** (`account-service/src/linking.mjs:16-17`, `account_oauth.rs:364-372`): the service can swap it without changing the code.
- **I2, approve and confirm accept the bare desktop OAuth access token** (`account-service/src/routes/linking.mjs:156-206`): no desktop signature, no signed wrap, no key confirmation (relay design 4.6, 4.8). A stolen access token can approve and confirm, and a web session within 5 minutes of its passkey sign-in can obtain such a token through consent (`routes/oauth.mjs:78-80`) and link its own browser with no desktop click.
- **I3, confirm sets `linked` without checking the current status** (`routes/linking.mjs:202`), and revoke and replace (`devices.mjs:87-89`, `103-114`) never touch `link_requests`: a device revoked while waiting for confirm comes back, and a new desktop can confirm a request the old desktop approved.
- **I4, browser keys are extractable and live only in page memory** (`link.js:42-43`), and the ECDH key is created for `deriveKey`, not `deriveBits`: a linked browser loses its keys on reload and can never sign or unwrap.
- **I5, two token-hash encodings** (`link.js:52`, `:68` hash the raw 32 bytes; `tests/linking.test.mjs:31` and `oauth.mjs:19` hash the base64url string). Latent today because nothing checks device tokens; the relay plan adopted the raw-bytes form. The token is also saved before linking and never cleared on deny or expiry.

### Minor

No cap on pending requests per user and only 10/min per IP, with a requester-chosen label (look-alike flooding of the desktop prompt); device rows for abandoned requests are never cleaned up; status and key calls are scoped to the user, not the starting session; audit events record no device id.

### Holds up

Server-side expiry on every call; each step once only (replayed approve is 409); cross-user access is 404; separate hash prefixes; about 19.9-bit SAS with negligible bias; no keys or tokens in logs or audit; `link.js` uses `textContent`; the accounts CSP is strict.

### Tests

None models a malicious service, so C1, C2 and I1 would pass; nothing tests revoke-then-confirm, rate limits, the browser's hash bytes or the token-hash form. Add a malicious-service test that substitutes keys and nonces at every step and asserts the two SAS values differ.

## Web pairing screen and site

**Pairing screen:** safe. Markup and CSS only; `checkHostUrl`, the 6-digit check and PIN clearing are unchanged; the PIN is one-use, 10 minutes and never logged; no third-party code.

**Fixed since review 2:** export and delete buttons on the account page (`80928952`); site security headers in `deploy/vps/llm-ide.com.nginx` (CSP with `frame-ancestors 'none'`, nosniff, `X-Frame-Options`, no-referrer, HSTS); nginx config for both hosts.

**Still open:**

- Inline `style=` on three marketing pages (`auto-tasks.html`, `code-graph.html`, `chat.html`).
- Tour keyboard handling with no focus guard and no `aria-live` (`marketing/site.js:73-76`).
- Whether `VITE_BASE=/app/` is wired into the deploy (not verified).
- Overclaims, all in public copy:
  - The relay is presented as built: `how-it-works.html:24,29` ("Encrypted envelopes", "the cloud remains blind") and `security.html` ("Encrypted relay", present tense).
  - Device approval is presented as built: "Desktop approves every device" (`how-it-works.html:29`, `why.html`) and the "Browser approved by desktop" chip (`index.html`). v1 has the flaws above and grants nothing yet.
  - `pricing.html`: a plan-change commitment with no pricing decision, and "device linking free during the preview".
  - Public sign-up is promoted on every page, though it is a launch gate.
  - Windows Hello in `guide.html:40`, and no page says today's desktop app is macOS only. Explorer, Terminal, Issues and Gantt, and Doc Gen are Mac-app features.
  - `guide.html`: "host address is prefilled" is unconfirmed, and step 11 reads as working end to end though the Swift Mac app has no pairing card.
  - `PairingScreen.tsx`: the "Meetings / Library" chips overstate the web client (chat, approvals, and read views off by default), and "Settings → Host API pairing" exists only in the Tauri desktop.
- Legal pages need lawyer review before launch; privacy names no infrastructure or email provider.
