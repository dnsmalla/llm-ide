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
| Account service + relay | **retired** 2026-11-06 (ADR 0020) and removed from the repo; see [Retire the account service](#retire-the-account-service-adr-0020-sync-sp8-run-once) |
| Own-server sync | SFTP user `llmidesync` (chroot `/srv/llmide-sync`), nginx `https://llm-ide.com/sync/`; setup [sync-sftp.md](sync-sftp.md) |
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

`/host-api/` was a temporary SSH-tunnel path; it now answers 404. Phones and browsers reach the
desktop's data through encrypted sync (ADR 0020).

## Retire the account service (ADR 0020, sync SP8) — run once

The account service and relay are removed from the repo (their code, units and vhost stay in git history,
last at commit `7724aa79`). If the VPS still runs them, run this once:

```bash
systemctl disable --now llmide-accounts
rm -f /etc/systemd/system/llmide-accounts.service /etc/logrotate.d/llmide-accounts && systemctl daemon-reload
# Either keep the 410 vhost (git show 7724aa79:deploy/vps/accounts.llm-ide.com.nginx) until the
# certificate lapses, or drop the site:
rm -f /etc/nginx/sites-enabled/accounts.llm-ide.com && nginx -t && systemctl reload nginx
# Keep /var/lib/llmide-accounts until you decide to delete it (it holds the account rows and audit log).
```

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
  code execution on the VPS. Do not reopen it: phones and browsers use encrypted sync (ADR 0020). Keep the admin
  credentials in a password manager, not in `/root/llm-ide-admin.txt`.
- DNS was moved from Squarespace; old resolvers may serve the old A records until the 30-minute TTL
  expires. Flush the Mac cache with `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.

## Own-server sync

`sync-sftp.md` sets up the chrooted `llmidesync` account, sshd `Match` block and nginx `/sync/` locations. Files: `50-llmidesync.conf`, the sync blocks in `llm-ide.com.nginx`, and `check-sync.sh`. Run the read-only checks after any change.
