# `llm-ide.com` VPS deployment

This is the layout running on `root@72.62.76.92` (Ubuntu 24.04). It is additive: the existing
`sites-enabled/*` apps and PM2 services are untouched.

## What runs where

| Piece | Location |
|---|---|
| Web PWA | `https://llm-ide.com` → `/var/www/llm-ide-web` |
| Public core API | **closed** 2026-11-05: `https://llm-ide.com/api/*` answers 404 (see Known limits) |
| Host API WebSocket | `wss://llm-ide.com/host-api/v1` → nginx → reverse SSH tunnel → this Mac's `127.0.0.1:3016` |
| Core service | `llmide-core.service`, user `llmide`, data `/var/lib/llmide`; **disabled** 2026-11-05 |
| Core runtime | `/opt/node22/bin/node` (the system Node remains 20 for the existing apps) |

The web client is built with:

```bash
VITE_HOST_API_URL=wss://llm-ide.com/host-api/v1 npm run build
```

## Install pieces

```bash
install -d -m 700 -o llmide -g llmide /var/lib/llmide /etc/llm-ide
git clone --depth 1 https://github.com/dnsmalla/llm-ide.git /srv/llm-ide/repo
# .skills is a private submodule; copy the local checkout or provision a deploy key.
cd /srv/llm-ide/repo && bash scripts/install-skills.sh
```

`/etc/llm-ide/core.env` must be `0600` and contain at least:

```dotenv
NODE_ENV=production
PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin
LLMIDE_HOST=127.0.0.1
LLMIDE_PORT=3457
LLMIDE_DATA_DIR=/var/lib/llmide
LLMIDE_DB_PATH=/var/lib/llmide/llmide.db
LLMIDE_BACKUP_DIR=/var/lib/llmide/backups
LLMIDE_BACKUP_KEEP=3
LLMIDE_DISABLE_REGISTRATION=1
LLMIDE_JWT_SECRET=<64 hex chars>
LLMIDE_VAULT_KEY=<64 hex chars>
```

The first account was created with registration temporarily open, then `LLMIDE_DISABLE_REGISTRATION=1`
was restored and the service restarted. The credentials are root-owned at `/root/llm-ide-admin.txt`
(mode `0600`) — move them into a password manager and remove that file.

## nginx

The full vhost is [llm-ide.com.nginx](llm-ide.com.nginx). It is enabled as
`/etc/nginx/sites-enabled/llm-ide.com`; certificates come from Certbot:

```bash
certbot certonly --webroot -w /var/www/llm-ide-web \
  -d llm-ide.com -d www.llm-ide.com
```

`/host-api/` is a WebSocket upgrade proxy to the reverse tunnel. `proxy_ssl_verify off` is
required because the desktop Host API listener uses a pinned self-signed identity; nginx, not
the browser, verifies the public certificate.

## Mac side

The desktop app must run with the Host API TLS listener and allow the exact page origin:

```bash
LLMIDE_HOST_API_TLS=1 \
LLMIDE_HOST_API_WEB_ORIGINS=https://llm-ide.com \
npm --prefix desktop run tauri dev
```

A LaunchAgent (`com.llmide.hostapi-tunnel`) holds:

```bash
ssh -N -R 127.0.0.1:3016:127.0.0.1:3016 root@72.62.76.92
```

Do not turn on `LLMIDE_HOST_API_READ` (chat history and usage over Host API v1) for a host reached through this tunnel yet. Through it, nginx on the VPS terminates TLS and sees tokens and chat text in the clear, every internet client reaches the listener as `127.0.0.1` (one shared pairing throttle, so one client can lock the owner out of pairing, and the audit log loses the real address), and other VPS processes can reach the tunnel port without nginx's Origin check. Wait until the real client address is forwarded and end-to-end encryption to the host exists (the relay design).

Keep that process running; it is what makes the public `wss://` URL reach the Mac. If the host app
is restarted, the listener keeps port 3016 and the tunnel reconnects.

## Verify

```bash
curl --resolve llm-ide.com:443:72.62.76.92 -o /dev/null -w '%{http_code}\n' https://llm-ide.com/api/health   # 404 (closed)
curl --resolve llm-ide.com:443:72.62.76.92 https://llm-ide.com/
curl --http1.1 -k --resolve llm-ide.com:443:72.62.76.92 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: https://llm-ide.com' https://llm-ide.com/host-api/v1 -D -
# 101 Switching Protocols
```

Pair from the web page with a PIN from **desktop Settings → Host API pairing**.

## Known limits

- The core's Claude CLI is installed but not authenticated. Model-generating pipeline steps will fail
  until `claude login` or a per-user API key is configured.
- `/api/*` is closed (404) and `llmide-core` is disabled (2026-11-05). It exposed the full core to the
  internet, and every core user is an admin (agents, MCP stdio, plugin installs), so one leaked login meant
  code execution on the VPS. Do not reopen it: public accounts come from the separate `account-service`
  (ADR 0019, `docs/superpowers/specs/2026-11-05-accounts-and-device-linking-design.md`). Keep the admin
  credentials in a password manager, not in `/root/llm-ide-admin.txt`.
- DNS was moved from Squarespace; old resolvers may serve the old A records until the 30-minute TTL
  expires. Flush the Mac cache with `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.
