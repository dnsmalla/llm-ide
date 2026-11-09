---
title: Connect the desktop to a server (remote mode)
applies_to: desktop
---

# Connect the desktop to a server

This is the daily setup: you already have a running LLM-IDE hub (someone installed it, or you did
once), and you want the desktop, web app and iPhone to use it. You do **not** need SSH, a private key
or a deploy step.

> Installing the server itself? See **[Install a server](install-a-server.md)**. The installer is a
> one-time operator task; connecting is the normal, repeated flow.

## What you need

- The hub's public **HTTPS URL**, for example `https://hub.example.com`.
- Your hub **email and password**.
- A hub certificate that is valid for that domain. A normal public-CA (Let's Encrypt) certificate
  needs no pin and no extra trust step.

## Connect from the desktop

1. Open **Settings → Server & Backend → Remote server**.
2. Enter the **Server URL**, **Email** and **Password**.
3. Press **Test connection** (optional). It checks DNS, TLS and `/health` without sending the
   password. A public-CA certificate is reported as trusted automatically; no pin is needed.
4. Press **Connect**. The desktop host calls the hub's `POST /auth/login`, stores the refresh token
   in the OS keychain, records remote mode and restarts.
5. After the restart the app is in **remote mode**: no local core is spawned. The card shows
   **Connected as email (role)**, and the hub project picker lists the projects your account can use.

The password is sent once to the hub and is never written to `prefs.json`, the webview storage,
logs or the keychain. The long-lived refresh token is kept in the OS keychain
(service `com.llmide.desktop`, account `hub-session`).

## What happens on later launches

In remote mode the desktop does this on launch:

1. Starts no local core; it starts the loopback-only proxy to the hub.
2. Reads the keychain session for the saved URL + pinned identity.
3. Exchanges the refresh token at `POST /auth/refresh` (the token rotates and the new one is stored).
4. Loads the hub's projects for the project picker.
5. If the hub answers `401` (session expired or revoked), the keychain entry is cleared and the
   sign-in panel returns. A network failure keeps the entry for the next launch.

The access token lives in memory only. The default is ordinary WebPKI trust; an optional pin is a
fallback, described below.

## Switching back to Local desktop

Remote mode is never left silently. In **Settings → Server & Backend → Remote server**:

- choose **Local desktop**, or press **Switch to Local desktop…**, and confirm.

The app writes local mode and **restarts the core** on this computer. Local mode keeps
using MEGA/Box/SFTP sync for web and mobile while the desktop is online (ADR 0020).

## TLS: public CA first, pin only as a fallback

| Situation | What the app does |
|---|---|
| Public CA certificate (Let's Encrypt, etc.) | Validates it against the public WebPKI roots. **No pin is required.** |
| You explicitly trust one certificate | Under **Advanced**, probe the certificate and press **Trust this certificate**. The leaf SPKI pin is stored and enforced *in addition to* chain validation. |
| A pinned certificate changed | The proxy answers `HUB_PIN_MISMATCH` and the app refuses the connection until you probe and trust the new pin, or remove the pin. |
| A private/self-signed CA | Not trusted by the public roots. Use the optional pin **only** if you trust that server; the pin never replaces chain validation. |

The optional pin is under **Show Install or manage server over SSH → Hub certificate pin (optional)**. A public-CA certificate is valid without ever opening that section. **Use public-CA trust** removes a
pin.

## Clear errors

| Message | What to do |
|---|---|
| The email or password is incorrect. | Check the account on the hub. Ten failures in a row are rate-limited. |
| The hub did not answer. | Check the URL, DNS, firewall and that the hub service is running (`systemctl status llmide-core` on the server). |
| The hub's TLS certificate is not trusted by a public certificate authority. | Check that the URL's domain matches the certificate. If you operate the server, fix the certificate; pin only as an explicit fallback. |
| The hub's certificate changed. | Probe the certificate again in Advanced, compare the fingerprint with the server operator, then trust it — or remove the pin. |
| This account can sign in but has no project access. | Ask a hub owner to add the account to a project (Team → project roles). |
| The OS keychain could not store the session. | Unlock the keychain/credential store and connect again. There is no plaintext fallback. |

## Web and iPhone

Both already accept a hub URL and pairing:

- **Web:** open `https://<hub>/app/`, enter the hub address and the six-digit pairing PIN from
  **Settings → Host API pairing → Show PIN**.
- **iPhone:** scan the hub's pairing QR. A public-domain hub uses port 443 and the QR carries the
  Host API certificate pin (`h1fp`); the phone pins it only from that explicit pairing offer. Manual
  entry is for a private/Tailscale address and never adopts a public name without a QR pin.

No separate "remote mode" switch exists on web or iPhone; they pair with the hub directly.

## Advanced: SSH deploy, update and uninstall

The old SSH fields and deploy controls are still available, but they are no longer the default:
expand **Install or manage server over SSH** in the same card. That section keeps Test SSH, the
host-key fingerprint confirmation, deploy preflight/run/rollback, update, backup, logs, diagnostics
and uninstall. None of it is needed to connect to a hub someone else runs.

## Related

- [Install a server](install-a-server.md) — the one-command Ubuntu/Debian installer
- [Run an always-online hub](run-a-hub.md) — operator details, backups, updates, limits
- [Desktop core lifecycle](desktop-core-lifecycle.md)
