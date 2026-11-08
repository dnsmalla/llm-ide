---
title: Configure the desktop's server mode (phase 1)
applies_to: desktop
---

# Configure the desktop's server mode (phase 1)

The desktop app normally runs its Node core on the same computer. **Settings → Server & Backend →
Remote server** lets you record that the backend should instead live on an SSH host, and test that
the connection works. Phase 1 is deliberately small: it **saves the choice and tests SSH**. It does
**not** deploy, install, start or move anything yet.

## What phase 1 does

| Mode | What the desktop does |
|---|---|
| **Local desktop** | Runs the bundled core on this computer, as before. Web and mobile clients read MEGA sync while this desktop is online. |
| **Remote server** | Stores the SSH target and checks it on demand. The core still runs locally until phase 2 lands deploy. |

The local copy shown in the card is: *"Desktop uses MEGA sync for web/mobile while it is online."*

## Choose a mode and test the connection

1. Open **Settings → Server & Backend**.
2. Under **Remote server**, choose **Local desktop** or **Remote server**.
3. For **Remote server**, fill in:
   - **Host or IP** — a hostname, IPv4 address or IPv6 literal. It may not start with `-`, contain
     whitespace, `user@` or a `:port` suffix.
   - **SSH port** — defaults to **22**.
   - **SSH user** — letters, digits, `.`, `_` and `-`; it may not start with `-`.
   - **Private key path** — the **absolute** path to an existing private key file, for example
     `/Users/you/.ssh/id_ed25519`. `~` is not expanded; write the full path.
   - **Label** (optional) — a name such as `production`.
4. Press **Test SSH**. The host runs the system `ssh` with a fixed argument array:
   - `BatchMode=yes` — never prompt for a password or passphrase;
   - `ConnectTimeout=10` — fail a dead host quickly;
   - `StrictHostKeyChecking=accept-new` — learn a new host key the first time, refuse a changed one;
   - `IdentitiesOnly=yes` and `-i <key path>` — use only the key you named, not keys in an agent.
5. A successful test shows the **host key type**, the **fingerprint** (`SHA256:…`), the remote
   **uname**, and whether **Node** is on the remote `PATH`. Compare the fingerprint with the one the
   server operator published before you trust the server.
6. Press **Save server settings** to keep the mode and the non-secret connection fields.

There is **no password support in phase 1**, and no passphrase prompt. Use a key that ssh can read
without an interactive prompt (for example one loaded in `ssh-agent`, or an unencrypted key with
owner-only permissions). The webview never reads the key file.

## What is stored

The settings live in the desktop host's `prefs.json` in the app data folder, which is written
atomically with owner-only permissions (`0600`):

- the mode;
- host, port, user, label;
- the **private key path**.

The private key's **contents, passphrase and any password are never stored** in `prefs.json`, the
webview or `localStorage`. The host checks that the path names a regular file, then passes the path
to `ssh`; it never opens the key.

## Errors you may see

| Message | What to do |
|---|---|
| The host / SSH user / private key path is not valid | Fix the shape shown in the field error. Values starting with `-` are refused so they can never become ssh options. |
| No private key file was found at that path | Check the absolute path and that the file exists on **this** computer. |
| SSH could not connect: Permission denied (publickey). | The server does not accept this key for that user. Add the matching public key to the server's `authorized_keys`. |
| SSH could not connect: Connection timed out | Check the host, port, firewall and that sshd is running. |
| Changed host key / host key verification failed | The server's host key changed. Stop and verify it out of band before removing the old entry from `known_hosts`. |
| SSH connected but did not report the host key fingerprint | The local ssh is unusually old or configured not to print debug output. Update OpenSSH and retry. |
| Node is not on the remote host's PATH | Informational in phase 1. Phase 2 deploy ships its own pinned Node 22, so the server does not need a system Node. |

## Security notes

- Values are validated before a child process exists: the host and user may not start with `-`, and
  the key path must be absolute. The command is built as an argv array (`std::process::Command`),
  never a shell string, so no field is interpreted as shell syntax.
- The remote command is a fixed literal. No host, user, label or path is interpolated into it.
- The host never logs the ssh argv, the key contents or its stderr. An error keeps at most one
  non-debug stderr line, bounded and stripped of control characters.
- A host key learned by `accept-new` is written to the normal `~/.ssh/known_hosts`. A later key change
  fails closed. Phase 2 moves deploy to an app-owned `known_hosts` and `StrictHostKeyChecking=yes`
  after an explicit trust step.

## Phase 2 — deploy and run the backend remotely (not in phase 1)

Phase 2 turns the saved choice into a running hub on the user's own server: the existing core started
in hub mode, reached through nginx TLS, with systemd supervision. The intended scope, in order:

1. **Read-only preflight and a plan (`remote_deploy_plan`)**. Reuse the validated target and the
   injected runner. Over one ssh connection, check the OS/arch (Ubuntu/Debian x86_64), `systemctl`,
   `nginx`, `certbot`, passwordless `sudo -n`, free disk (at least 2 GB), any existing
   `/opt/llmide/current/VERSION`, and that the domain resolves to the server. The result is a fixed
   stage list with blockers and warnings; no mutating command runs until the user confirms the plan.
2. **One fixed privileged helper**. The app uploads a root-owned `/usr/local/sbin/llmide-deploy` and a
   sudoers entry with **one line per stage** (`base`, `env`, `bundle`, `nginx`, `start`,
   `open-registration`, `lock-registration`, `rollback`, …) and no wildcard. The helper dispatches on
   an enum argument, reads fixed paths, and never runs user-supplied text. A missing `sudo -n` gives
   the user one copy-paste bootstrap command instead of a password prompt in the app.
3. **Upload the already-staged Linux core**. `desktop/scripts/stage-hub-core.mjs` packages the pinned
   Node 22 and production dependencies into a tarball with `VERSION` and `SHA256SUMS`. The app streams
   it to the server over ssh **stdin** (no `scp` path parsing), the helper verifies the checksum and
   unpacks it to `/opt/llmide/releases/<version>`, then switches `current` and keeps `previous` for
   rollback. The server needs no Node, npm or compiler.
4. **Service and secrets**. A dedicated `llmide` system user with no shell owns `/var/lib/llmide`; a
   systemd unit runs the core under `EnvironmentFile=/etc/llmide/core.env`. The app generates the JWT
   and vault secrets with the OS RNG, sends the env file over ssh stdin, and the helper installs it
   `0600 root:root`. Secrets never appear in argv, a log, an event payload or the DOM.
5. **nginx and TLS**. The core stays on loopback; nginx is the only 443 listener, proxies the API and
   the Host API v1 WebSocket, suppresses `/metrics` and the retired `/api` alias, and gets a Let's
   Encrypt ECDSA certificate with `--reuse-key`. The deploy publishes the leaf SPKI pin so the desktop
   and phone can pin it across renewals.
6. **Health gate, owner window, rollback**. After `start`, poll `https://<domain>/health` until it
   reports `dbOk` and hub mode; open registration just long enough for the user to create the owner,
   then lock it and verify `registrationOpen: false`. A failed stage or health timeout restores the
   previous release and nginx backup, restarts, and reports the failed stage; a consumed plan cannot
   be replayed.
7. **Desktop on the hub (`remote_server.mode = "remote"`)**. The next app start spawns no local core.
   A loopback-only, tokenized Rust proxy pins the hub's TLS key and forwards to it, so the webview
   still talks to a loopback URL and sends no credentials to an unverified core. The desktop signs in
   as a hub member; filesystem-only screens say "Local desktop only"; "Work offline" writes local mode
   and restarts. This is a restart-time switch, not a live switch.
8. **Web and iPhone**. The hub serves the existing web app; Host API v1 pairing points at
   `wss://<hub>/host-api/v1` and the same project roles apply. The iPhone public-domain case is a
   separate, explicitly gated change; a private/Tailscale name needs none.
9. **Tests and rollout**. Fake-runner preflight and stage tests (no real SSH in CI), helper `sh -n`
   and template golden tests, release-switch/rollback tests, a vhost/no-`/api` test, and one opt-in
   end-to-end run against a disposable server. API 129 is additive and no DB migration is needed;
   local mode keeps exactly today's behaviour, and an older prefs file reads as local.

Until phase 2 ships, Remote server mode changes no runtime behaviour: the core keeps running locally.

## Related

- [Desktop core: data location, lifecycle, `claude` discovery](desktop-core-lifecycle.md)
- [Box / own-server sync setup](sync-box-setup.md) — encrypted snapshots for phones and web (ADR 0020)
