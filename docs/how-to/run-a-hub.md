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
   health gate, then a one-time owner setup window. Any failure runs the previous release back.
7. Open the setup link shown once. It uses a 32-byte `#fragment` token (never a query string or an
   access log); create the owner, then press **I created the owner — close registration**. Verify
   `/auth/well-known` says registration is closed.

## Day two

- **Status/logs:** Settings shows the hub status; `remote_diagnostics`/`remote_logs` return bounded,
  redacted data (no env file, no prompt text).
- **Backups:** the core's daily backup keeps 7 stamps under `/var/lib/llmide/backups`; **Backup
  now** runs the fixed one-shot. Copy them off the host (see `deploy/vps/README.md`).
- **Update:** build a new bundle, upload/switch (the same `bundle`/`start` stages with a health gate),
  and keep the previous release for rollback. A failed health check restores it automatically.
- **Revoke:** Settings → Phone and browser revokes a device; it is disconnected immediately.
- **Uninstall:** stops/disables the service, removes the unit/vhost/helper and keeps
  `/var/lib/llmide`; the purge stage deletes data only after typing the hostname.

## Limits (stated plainly)

- The hub is one host. If it is down, the desktop offers **Work offline** (restart into local mode);
  phones and browsers have no live data until it returns.
- Sync/MEGA is a **local-mode** feature. A hub refuses `/kb/sync/*` with `SYNC_LOCAL_ONLY`.
- On a hub, `/health` is public and says `hub: true` plus the API version. That is intentional.
- The iPhone pairing QR must use a hostname the app accepts: a private/Tailscale name in v1, or the
  public-host change in P4.6 (the iOS freeze is lifted only for that task).
