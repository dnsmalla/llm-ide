# LLM-IDE web client

The Host API v1 web client: pairing, chat and approvals. It talks only to the host's Host API v1 WebSocket and never calls the core's HTTP routes.

## Run it locally

```bash
# 1. the desktop (debug build) with the dev listener and this page's origin allowed
LLMIDE_HOST_API_DEV=1 LLMIDE_HOST_API_WEB_ORIGINS=http://127.0.0.1:5180 \
  npm --prefix desktop run tauri dev

# 2. the web app (dev server)
cd web && npm ci && npm run dev

# 3. desktop Settings > Host API pairing > Show pairing PIN, then open
#    http://127.0.0.1:5180 and enter ws://127.0.0.1:<port shown>/host-api/v1
#    and the PIN.
```

For the production bundle, `npm run build && npm start` serves `dist/` from
the same origin with the CSP as a response header, SPA fallback and immutable
hashed assets. `PORT`/`HOST` change the bind; `TLS_CERT`/`TLS_KEY` enable
direct HTTPS. See [DEPLOY.md](DEPLOY.md) for local and domain setup.

## Moving to your domain

The web client already accepts `wss://` and the CSP allows it. The host side
(TLS listener, certificate fingerprint, exact-origin allowlist) is in Host API
Plan 6.

- Build with `VITE_HOST_API_URL=wss://<host>:<port>/host-api/v1`.
- Serve `web/dist` over HTTPS, with the same CSP sent as a header.
- Add `https://<domain>` to `LLMIDE_HOST_API_WEB_ORIGINS` on the host.
- The browser must trust the host's certificate. A self-signed certificate
  needs a manual trust step; Chromium Private Network Access may block an
  HTTPS page from reaching a LAN or loopback host.
- A reverse proxy (Caddy) is the recommended way to serve the bundle; keep the
  static server on loopback unless you are terminating TLS yourself.

## Manual check

Use [MANUAL-CHECK.md](MANUAL-CHECK.md) before calling a release shipped.

## Offline sync (desktop off)

When the desktop is not reachable, a browser linked to sync reads the desktop's last encrypted snapshot (chats,
meetings with notes, plans and tasks, usage) from the user's dedicated MEGA account and can queue chat prompts that
run, read-only, when the desktop is back (design: docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md).

- Link it from the desktop: Settings → sync → Add a phone or browser → Browser. Open the link here (or paste it on the
  Pairing screen) and compare the 6-digit code on both screens. An app installed to the iPhone home screen has storage
  separate from Safari and cannot receive an opened link, so paste the link into its Pairing screen instead.
- The MEGA password is asked once per session and never stored. Device keys are non-extractable WebCrypto keys in
  IndexedDB (`llmide-sync`). Snapshots and replies stay in memory only.
- The CSP adds exactly `https://g.api.mega.co.nz https://*.userstorage.mega.co.nz` to `connect-src`.
- Known risk, unverified: only `g.api.mega.co.nz` was checked to answer cross-origin (CORS) requests. If MEGA's file
  transfer hosts (`*.userstorage.mega.co.nz`) send no CORS headers, the browser can sign in but cannot download or upload
  sync files. MANUAL-CHECK.md step 3 checks this; the fallback is a credential-free download proxy on the VPS.
- Code: `src/sync/`. Tests: `tests/sync-*.test.mjs` (vectors, malicious storage, fake MEGA) and
  `tests/e2e/sync-desktop-e2e.test.mjs` (real desktop sync code).

## Documents and code at the source

The web app reads Box documents and GitLab code directly from the user's own accounts, read-only, with or without
the desktop (design §9). Nothing passes through sync, and nothing read is stored.

- Sign-in is OAuth with PKCE in a pop-up: GitLab `read_api read_repository` (an application with Confidential
  unticked), Box `root_readonly` (the user's own Box Custom App; Box needs its client secret, which stays in
  IndexedDB `llmide-sources`). Tokens live in memory only, so each browser session signs in again.
- Redirect URI: `<site>/oauth-callback.html` (for example `https://llm-ide.com/app/oauth-callback.html`; in
  development `http://127.0.0.1:5180/oauth-callback.html`). Box also needs the site origin in its CORS Domains.
- The CSP adds exactly `https://gitlab.com https://api.box.com https://dl.boxcloud.com https://public.boxcloud.com` to
  `connect-src`. gitlab.com only; self-hosted GitLab is not supported yet.
- Code and text show as plain text (1 MiB cap), Markdown without HTML or images, PDFs as "Save PDF" only, Office files
  as Box's extracted text. Setup: docs/how-to/read-box-gitlab-on-phone-and-web.md.
- Code: `src/sources/`. Tests: `tests/sources-*.test.mjs` (fake APIs); live: `npm run test:live` (opt-in).

## Installable shell

The built client is a PWA: `manifest.webmanifest`, PNG/SVG icons and a service worker that caches only the app
shell and hashed assets. It never caches the Host API socket, tokens or cross-origin responses. The installed
client opens offline with a clear "Offline" state until the host is reachable. Service-worker registration is
production-only; `npm run dev` never installs one.

Install needs HTTPS, except on `localhost`/`127.0.0.1`, where browsers allow it for development.

## Security notes

- The token lives in `localStorage` per host; **Forget this host** revokes it. The PIN is never stored.
- The CSP is in the built page. There is no raw HTML, and plaintext `ws://` is allowed only to loopback.

## Tests

- `npm test`: unit and server-render tests.
- `npm run test:e2e`: starts the real core and binds local ports (run it unsandboxed).

The CSP adds exactly `https://g.api.mega.co.nz https://*.userstorage.mega.co.nz` (MEGA) and `https://api.box.com https://upload.box.com https://*.boxcloud.com` (Box) to `connect-src`.
