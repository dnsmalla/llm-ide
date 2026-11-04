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
hashed assets. `PORT`/`HOST` change the bind.

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

## Manual check

Use [MANUAL-CHECK.md](MANUAL-CHECK.md) before calling a release shipped.

## Security notes

- The token lives in `localStorage` per host; **Forget this host** revokes it. The PIN is never stored.
- The CSP is in the built page. There is no raw HTML, and plaintext `ws://` is allowed only to loopback.

## Tests

- `npm test`: unit and server-render tests.
- `npm run test:e2e`: starts the real core and binds local ports (run it unsandboxed).
