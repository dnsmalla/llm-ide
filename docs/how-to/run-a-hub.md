# Run an always-online hub (remote server mode)

LLM-IDE has two server modes. **Local desktop** is the default: the app runs the Node core on this
computer and phones/browsers read encrypted MEGA/Box/SFTP snapshots while it is online (ADR 0020).
**Remote SSH hub** runs the same core on a server you own, behind nginx TLS, so the desktop, web app
and iPhone work while your computer is off. This page is the operator path; decisions and the full
task list are in `docs/superpowers/plans/2026-11-08-remote-server-modes.md` (D1–D11 approved).

## Before you start

- A server you own (Ubuntu 24.04 x86_64), root or sudo, a DNS name, and ports 80/443 reachable.
- An SSH key that logs in without a password prompt (`BatchMode`).
- A TLS certificate for the name. The deploy installs the vhost but **does not run Certbot for you**:
  run `certbot certonly --webroot -w /var/www/llmide-web -d <domain> --key-type ecdsa --reuse-key`
  first. `--reuse-key` keeps the leaf key stable so the desktop/phone pins survive renewal.
- An external security review is a gate before this hub is public. The deploy plan carries the
  `external_security_review_required` blocker until you tick the review acknowledgement.

## Deploy from the desktop

1. **Settings → Server & Backend → Remote server.** Enter host, SSH port, user, the absolute private
   key path and a label. Press **Test SSH**; compare the fingerprint with the server's
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` and trust it.
2. Enter the **Hub URL** (`https://<domain>`), press **Probe TLS**, compare the SPKI fingerprint, and
   press **Trust this certificate**. A changed key fails closed; probe and trust again.
3. Press **Install helper** (one fixed root helper, exact sudoers lines). If sudo asks for a
   password, run the printed command once in a terminal and retry.
4. Enter the domain, run **Preflight**, and read the blockers/warnings. A missing nginx/certbot,
   ARM host, password-sudo server, less than 2 GB free, or a missing hub bundle blocks the deploy.
5. Build the bundle on the machine that stages the app: `node desktop/scripts/stage-hub-core.mjs`
   (Linux x64, pinned Node 22.23.4 + production deps; no npm on the server). The plan looks for
   `desktop/dist/hub/llmide-core-<version>-linux-x64.tar.gz`.
6. Type the domain in the confirmation field and press **Deploy**. The stages are: pre-deploy backup
   (existing installs), service user/dirs, secret env over stdin, bundle + SHA-256, nginx, start,
   health gate, then a one-time owner setup window. A failure restores the previous release when one
   exists; on a first install there is nothing to restore, and the card says so.
7. Open the setup link shown once. It uses a 32-byte `#fragment` token (never a query string or an
   access log); create the owner, then press **I created the owner — close registration**. Verify
   `/auth/well-known` says registration is closed.

## Day two

- **Status/logs:** Settings shows the hub status; `remote_diagnostics`/`remote_logs` return bounded,
  redacted data (no env file, no prompt text).
- **Backups:** the core's daily backup keeps 7 stamps under `/var/lib/llmide/backups`; **Backup
  now** runs the fixed one-shot. Copy them off the host (see `deploy/vps/README.md`).
- **Update:** build a new bundle, upload/switch (pre-update backup + the same health gate as a deploy),
  and keep the previous release. A failed health check restores it automatically; a failed first install
  has nothing to restore and says so.
- **Revoke:** Settings → Phone and browser revokes a device; it is disconnected immediately.
- **Uninstall:** stops/disables the service and removes the unit/vhost, helper and sudoers entry; it keeps
  `/var/lib/llmide` and `/srv/llmide/projects`. Purge is a helper stage (runbook only), not a UI button; it
  also removes `/etc/llmide` (the JWT/vault keys) after the same hostname confirmation.

## Limits (stated plainly)

- The hub is one host. If it is down, the desktop offers **Work offline** (restart into local mode);
  phones and browsers have no live data until it returns.
- Sync/MEGA is a **local-mode** feature. A hub refuses `/kb/sync/*` with `SYNC_LOCAL_ONLY`.
- On a hub, `/health` is public and says `hub: true` plus the API version. That is intentional.
- The iPhone pairing QR must use a hostname the app accepts: a private/Tailscale name in v1, or the
  public-host change in P4.6 (the iOS freeze is lifted only for that task).

## Verification status (2026-11-08)

The helper was exercised end to end in a disposable, privileged Ubuntu 24.04 container (Docker
29.1.3, systemd 255 as PID 1, `--cgroupns=host`), not on a real server:

```sh
docker run -d --name llmide-deploy-test --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw ubuntu:24.04 \
  bash -c 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    systemd systemd-sysv openssh-server nginx certbot curl sudo ca-certificates \
    openssl coreutils tar gzip xz-utils && exec /lib/systemd/systemd'
```

The container used the generated per-stage sudoers drop-in (the operator's broad sudo was removed
before any stage ran). Stages: `base` → `env` → `env` again → `bundle` → `nginx` → `start` →
`open-registration` → `lock-registration` → `backup` → `uninstall`; then a fresh install and
`uninstall` with no `core.env`. Verified: `/etc/llmide` 0700, `core.env` 0600 root:root with
`core.env.prev`, JWT/vault preserved across the second `env`, the `llmide` user has
`/usr/sbin/nologin`, the unit is **enabled and active** with its hardening directives, the release
layout is `core/node/node`, `nginx -t` succeeds and the vhost answers HTTPS, the SPKI pin matches the
certificate, the narrow sudoers grant refuses `cat /etc/shadow`, and `uninstall` removes the unit,
vhost, helper and sudoers while keeping the database, projects and certificate.

What this does **not** prove: the real staged Linux core (a minimal Node 22 server stood in at
`core/root/extension/server.mjs`; `stage-hub-core.mjs` was not run on macOS), a public DNS name or
ACME issuance (the test domain was `hub.llmide.test` with a self-signed EC certificate under
`/etc/letsencrypt/live/`), the SSH transport and Tauri runner, a reboot, and the external security
review. Treat this as deploy-path evidence, not a production sign-off. The CI regression for the
helper is `desktop/scripts/helper-temp-root.test.mjs` (base/env/bundle/start, env edge cases,
uninstall, and vhost rejection).
