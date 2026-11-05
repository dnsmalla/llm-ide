# Deploying the web client

Two modes: local-only now, and a domain later. The app is the same bundle; only
the host URL, TLS and the host's origin allowlist change.

## Local (default)

```bash
# Desktop host: debug build with the dev listener and this origin allowed.
LLMIDE_HOST_API_DEV=1 \
LLMIDE_HOST_API_WEB_ORIGINS=http://127.0.0.1:5180 \
npm --prefix desktop run tauri dev

# Web client.
cd web
npm ci
npm run build
npm start            # http://127.0.0.1:5180
```

`npm run dev` is the hot-reload variant. The server binds loopback by default;
do not open plaintext `http://0.0.0.0` to a network.

## Domain with a reverse proxy (recommended)

Keep the Node server on loopback and let Caddy own DNS, certificates and HTTPS.
The bundle is static, so any static host works; the CSP header below must be
sent by the proxy or the server.

```caddyfile
web.example.com {
  root * /srv/llmide-web/dist
  try_files {path} /index.html
  header {
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss: https://g.api.mega.co.nz https://*.userstorage.mega.co.nz; base-uri 'none'; form-action 'none'; object-src 'none'"
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy no-referrer
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
  }
  file_server
}
```

Then:

1. Build the client with the host WebSocket URL:
   ```bash
   VITE_HOST_API_URL=wss://host.example.com:3016/host-api/v1 npm run build
   ```
2. Put the exact page origin in the host's allowlist:
   ```bash
   LLMIDE_HOST_API_TLS=1 \
   LLMIDE_HOST_API_WEB_ORIGINS=https://web.example.com \
   <the desktop app binary>
   ```
   The Host API TLS listener uses a self-signed identity; the browser must trust
   it once. Chromium may also apply Private Network Access rules when the page
   is public HTTPS and the host is on the LAN/loopback.
3. Open the domain and pair with the PIN from **Settings → Host API pairing**.

## Direct TLS without a proxy

The static server can terminate TLS itself:

```bash
TLS_CERT=/etc/ssl/web.example.com/fullchain.pem \
TLS_KEY=/etc/ssl/web.example.com/privkey.pem \
HOST=0.0.0.0 PORT=443 npm start
```

It sends HSTS in this mode. A proxy is still preferred for certificate renewal,
access logs and rate limiting.

## Installable output

The build ships `manifest.webmanifest`, icons and `sw.js`; `npm start` serves the manifest as
`application/manifest+json` and the worker with `no-cache`. Installation and service workers require HTTPS or
`localhost`; a plain-HTTP domain will load the page but not offer install/offline.

## Release checklist

- [ ] `npm ci && npm test && npm run build && npm run test:e2e`
- [ ] CSP is present in the response headers
- [ ] `VITE_HOST_API_URL` points at `wss://`, never a public `ws://`
- [ ] Host allowlist contains the exact HTTPS origin, no wildcard
- [ ] Certificate is trusted by the browser; PIN pairing works
- [ ] Token is per-browser; **Forget this host** revokes it
- [ ] Manual check in `MANUAL-CHECK.md` passes on the deployed URL
