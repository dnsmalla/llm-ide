# `llm-ide.com` VPS deployment

This is the layout running on `root@72.62.76.92` (Ubuntu 24.04). It is additive: the existing
`sites-enabled/*` apps and PM2 services are untouched.

## What runs where

| Piece | Location |
|---|---|
| Web PWA | `https://llm-ide.com` → `/var/www/llm-ide-web` |
| Public core API | **closed** 2026-11-05: `https://llm-ide.com/api/*` answers 404 (see Known limits) |
| Host API WebSocket | **retired** 2026-11-05; `/host-api/*` answers 404 (ADR 0019) |
| Core service | `llmide-core.service`, user `llmide`, data `/var/lib/llmide`; **disabled** 2026-11-05 |
| Account service | `accounts.llm-ide.com`, `llmide-accounts.service`, data `/var/lib/llmide-accounts`; sign-up closed |
| Core runtime | `/opt/node22/bin/node` (the system Node remains 20 for the existing apps) |

## Install pieces

```bash
install -d -m 700 -o llmide -g llmide /var/lib/llmide
install -d -m 700 -o root -g root /etc/llm-ide
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

`/host-api/` was a temporary SSH-tunnel path; it now answers 404. The relay design replaces it
with an outbound-only connection from the desktop.

## Account service (`accounts.llm-ide.com`)

Public accounts (ADR 0019; design `docs/superpowers/specs/2026-11-05-accounts-and-device-linking-design.md`).
Its own system user, database and loopback process; **sign-up is closed** until the external review.
It never runs the core, AI or agents.

| Piece | Location |
|---|---|
| Service | `llmide-accounts.service`, user `llmide-accounts`, `127.0.0.1:3470` |
| Data | `/var/lib/llmide-accounts/accounts.db` |
| Config | `/etc/llm-ide/accounts.env` (`0600`, root-owned) |
| nginx | [accounts.llm-ide.com.nginx](accounts.llm-ide.com.nginx); access log has no IPs, error log kept 3 days |

```bash
useradd --system --home /var/lib/llmide-accounts --shell /usr/sbin/nologin llmide-accounts
install -d -m 700 -o root -g root /etc/llm-ide
install -d -m 700 -o llmide-accounts -g llmide-accounts /var/lib/llmide-accounts
install -d -m 755 /var/www/llm-ide-accounts
cd /srv/llm-ide/repo && git pull --ff-only
cd account-service && chmod -R a+rX . && PATH=/opt/node22/bin:$PATH npm ci --omit=dev --no-audit --no-fund
```

`/etc/llm-ide/accounts.env`:

```dotenv
NODE_ENV=production
ACCOUNTS_HOST=127.0.0.1
ACCOUNTS_PORT=3470
ACCOUNTS_ORIGIN=https://accounts.llm-ide.com
ACCOUNTS_TRUST_PROXY=1
ACCOUNTS_DB_PATH=/var/lib/llmide-accounts/accounts.db
# Until a mail provider exists, use none (sign-up must stay closed). Switch to smtp when configured.
ACCOUNTS_MAIL_TRANSPORT=none
# ACCOUNTS_SMTP_URL=smtps://<user>:<password>@<provider-host>:465
ACCOUNTS_MAIL_FROM=LLM-IDE <no-reply@llm-ide.com>
# Do NOT set ACCOUNTS_SIGNUP_OPEN=1 before sub-project 5 (external review, legal gates).
# Direct sign-up (no email link) proves nothing about the address, so in production the service
# refuses to start with ACCOUNTS_DIRECT_SIGNUP=1 unless ACCOUNTS_DIRECT_SIGNUP_EMAILS names the exact
# addresses allowed (comma-separated, case-insensitive). Leave both unset once the first account exists.
# ACCOUNTS_DIRECT_SIGNUP=1
# ACCOUNTS_DIRECT_SIGNUP_EMAILS=you@example.com
```

```bash
# Write the environment file from the dotenv block above, then:
chown root:root /etc/llm-ide/accounts.env
chmod 600 /etc/llm-ide/accounts.env
cp deploy/vps/llmide-accounts.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now llmide-accounts
certbot certonly --webroot -w /var/www/llm-ide-accounts -d accounts.llm-ide.com
install -d -m 700 -o root -g root /var/log/llmide-accounts
cp deploy/vps/accounts.llm-ide.com.nginx /etc/nginx/sites-available/accounts.llm-ide.com
ln -s /etc/nginx/sites-available/accounts.llm-ide.com /etc/nginx/sites-enabled/
cp deploy/vps/llmide-accounts.logrotate /etc/logrotate.d/llmide-accounts
nginx -t && systemctl reload nginx
```

The DNS `A` record for `accounts.llm-ide.com` must point at the VPS before `certbot`. Until the
certificate exists, enable only the port-80 server block.

Verify:

```bash
curl -s https://accounts.llm-ide.com/health
# {"ok":true,"service":"account-service","signupOpen":false,"directSignup":false}
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://accounts.llm-ide.com' \
  -H 'Content-Type: application/json' -d '{"email":"a@example.com","displayName":"A"}' \
  https://accounts.llm-ide.com/v1/signup
# 403 (signup_closed)
curl -s -o /dev/null -w '%{http_code}\n' https://llm-ide.com/api/health
# 404
systemctl show llmide-accounts -p User
# User=llmide-accounts
```

## Device linking (v1)

The browser link page is served by the account service at `/link.html`; the desktop polls the same
service for pending requests. Public keys, commitments and nonces are stored; private keys and the
device token never leave the device.

- Migration `0004_link_requests.sql` creates `link_requests` and the unique device-token hash index.
- Endpoints: `POST /v1/link/requests`, `GET /v1/link/requests/status`, `POST /v1/link/requests/keys`
  (web session); `GET /v1/link/requests`, `POST /v1/link/requests/{approve,deny,confirm}` (desktop Bearer).
- The six-digit SAS is computed by both sides from the committed device keys, the desktop signing key,
  and both nonces. Confirm only when the codes match.
- Link requests expire after 10 minutes. The account service can refuse service but cannot read project
  data; the relay is still a later sub-project.

Deploy after pulling:

```bash
cd /srv/llm-ide/repo
git fetch origin main && git reset --hard origin/main
cd account-service
chmod -R a+rX .
PATH=/opt/node22/bin:$PATH npm ci --omit=dev --no-audit --no-fund
PATH=/opt/node22/bin:$PATH npm test          # 95/95
rsync -a --delete public/ /var/www/llm-ide-accounts/
chown -R root:root /var/www/llm-ide-accounts
systemctl restart llmide-accounts
curl -fsS https://accounts.llm-ide.com/health
# {"ok":true,"service":"account-service","signupOpen":false,"directSignup":false}
curl -s -o /dev/null -w '%{http_code}\n' https://accounts.llm-ide.com/link.html  # 200
```

Confirm direct sign-up stays off. The fixed service requires `ACCOUNTS_DIRECT_SIGNUP_EMAILS` if direct
sign-up is ever re-enabled in production; leaving it off is the safe default.

## Verify

```bash
curl --resolve llm-ide.com:443:72.62.76.92 -o /dev/null -w '%{http_code}\n' https://llm-ide.com/api/health   # 404
curl --resolve llm-ide.com:443:72.62.76.92 -o /dev/null -w '%{http_code}\n' https://llm-ide.com/host-api/v1  # 404
curl --resolve llm-ide.com:443:72.62.76.92 https://llm-ide.com/
```

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

## Relay (`/relay/v1`, sub-project 3) — NOT PUBLIC

The relay unit runs inside `llmide-accounts` and is **off** (`ACCOUNTS_RELAY` unset). It must stay unreachable
from the internet until the external security review (relay design D9, gate G-EXT) is complete and its findings are
resolved or accepted in writing. Do **not** add a `location /relay/` block to `accounts.llm-ide.com.nginx` and do
not set `ACCOUNTS_RELAY=1` on this host before then. Local and private-network testing only:

    ACCOUNTS_RELAY=1 ACCOUNTS_ALLOWED_WEB_ORIGINS=http://localhost:5173 node bin/account-service.mjs

The relay forwards ciphertext only, makes no LLM call, runs no code and makes no outbound connection. The core's
loopback bridge is `/host-api/relay-bridge` and is private to the bus host proof.

When G-EXT closes (later slice R8), the nginx block is: `location = /relay/v1 { proxy_pass http://127.0.0.1:3470;
proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 120s; }`, with
`ACCOUNTS_ALLOWED_WEB_ORIGINS=https://app.llm-ide.com`.
