---
title: Install a server (LLM-IDE hub)
applies_to: server
---

# Install a server

This is the one-time operator task: put an LLM-IDE hub on an Ubuntu/Debian server so desktop, web
and iPhone can use it. For the everyday "connect to a server that already exists" flow, see
**[Connect the desktop to a server](configure-remote-server.md)**.

The installer uses the same fixed helper, staged Linux core bundle, systemd unit and nginx vhost as
the desktop's deploy flow. The server needs **no Node, npm or compiler**.

## Before you start

- Ubuntu 24.04 or Debian 12, **x86_64**, root (or `sudo`).
- A public DNS name whose A/AAAA record points at the server. A public CA (Let's Encrypt) needs it.
- Ports **80** and **443** reachable.
- An Anthropic API key for the hub's model calls (or another provider key you configure later). The
  installer asks for it with hidden input; it is never an argument and never printed.
- A staged Linux core bundle. Build it on a machine with the repo and Node 22:

  ```sh
  node desktop/scripts/stage-hub-core.mjs
  # -> desktop/dist/hub/llmide-core-<version>-linux-x64.tar.gz
  ```

## One command

Copy the repo (or at least `deploy/hub/` and the bundle) to the server, then run as root:

```sh
sudo sh deploy/hub/install-hub.sh --domain hub.example.com
```

It reads the model key from `ANTHROPIC_API_KEY`, or prompts:

```sh
# In your own shell (not on the sudo command line):
export ANTHROPIC_API_KEY=sk-ant-...
sudo -E sh deploy/hub/install-hub.sh --domain hub.example.com
```

`ANTHROPIC_API_KEY` is an environment variable, not an argument: it does not appear in `ps` or the
installer's output. If you prefer not to put it in your shell, omit it and the installer prompts with
hidden input. If stdin is not a terminal, set the environment variable.

Options:

| Option | Meaning |
|---|---|
| `--domain <name>` | Public DNS name (required). |
| `--email <addr>` | Let's Encrypt account email. Without it certbot registers without an email. |
| `--bundle <path>` | Bundle to install. Default: search beside the script and in `desktop/dist/hub/`. |
| `--version <x.y.z>` | Bundle version. Default: parsed from the bundle filename or its `VERSION`. |
| `--skip-apt` | Do not install nginx/certbot/openssl (they must already be present). |
| `--dry-run` | Validate and print the plan; change nothing. Works as a normal user. |
| `--help` | Usage. |

## What it does

1. Validates the domain (public DNS name; not localhost, `.local`, or an IP literal).
2. Installs `nginx`, `certbot`, `openssl`, `curl`, `coreutils`, `tar` and `gzip` with apt unless
   `--skip-apt` is set.
3. Installs the fixed root helper at `/usr/local/sbin/llmide-deploy`.
4. Runs the helper's `base` stage: the `llmide` system user, `/opt/llmide`, `/var/lib/llmide`,
   `/srv/llmide/projects`, the systemd unit and the backup timer.
5. Requests an ECDSA certificate with `certbot --reuse-key` through a temporary ACME webroot vhost,
   then removes that temporary vhost.
6. Writes `/etc/llmide/core.env` over stdin (`0600 root:root`) with the JWT secret, vault key and the
   model key generated/read locally. The helper's `env` stage validates the key names and preserves
   the JWT, vault and model keys across later desktop deploys/updates.
7. Uploads the bundle, its SHA-256 and `VERSION`, verifies the checksum, unpacks it, requires the
   bundled Node 22, and switches `/opt/llmide/current`.
8. Installs the nginx vhost and the Host API certificate fingerprint file, starts `llmide-core`, and
   waits for `https://<domain>/health` to report healthy.
9. Opens a one-time owner registration window and prints its URL plus the next steps.

No secret is written to argv, stdout/stderr, the shell history or a log. The model key lives only in
the root-only env file; the helper's env stage never echoes it.

## After it finishes

1. Open the printed setup URL (the token is in the URL **fragment**, never in an access log) and
   create the **owner** account. The first account becomes the owner.
2. Close registration:

   ```sh
   sudo /usr/local/sbin/llmide-deploy lock-registration
   ```

3. Connect the desktop: **Settings → Server & Backend → Remote server**, enter
   `https://<domain>` and the owner email/password, press **Connect**.
4. Web: open `https://<domain>/app/`, enter the hub address and the pairing PIN from
   **Settings → Host API pairing**.
5. iPhone: scan the hub's pairing QR.

## Day two

- **Status:** `systemctl status llmide-core`; logs: `journalctl -u llmide-core -n 100`.
- **Backups:** the daily timer keeps 7 snapshots under `/var/lib/llmide/backups`; copy them
  off-host (see `deploy/vps/README.md`).
- **Update:** build a new bundle and use the desktop's **Advanced → Install or manage server over
  SSH → Update hub** (pre-update backup + health gate + rollback). Re-running the installer with the
  same version is refused by the helper's same-version guard.
- **Uninstall:** the desktop's Advanced section, or the helper's `uninstall` stage. Data is kept
  unless you deliberately run `uninstall-purge`.

## Security notes

- The core listens on `127.0.0.1:3457`; nginx is the only 443 listener and terminates TLS.
- The unit uses `LoadCredential` for the JWT and vault secrets, a strict `ProtectSystem` profile, a
  dedicated `llmide` user and a private `/var/lib/llmide`.
- The model key is in `/etc/llmide/core.env` (`0600 root:root`). Protect root on that host; anyone
  with root can read it. The same file is never sent to the desktop.
- Public-CA trust is the default; the certificate pin is optional and only used when a user
  explicitly trusts it.

## Related

- [Connect the desktop to a server](configure-remote-server.md)
- [Run an always-online hub](run-a-hub.md) — full operator runbook
