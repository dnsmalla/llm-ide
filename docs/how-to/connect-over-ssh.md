---
title: Connect the desktop to a Linux server over SSH
applies_to: desktop
---

# Connect the desktop to a Linux server over SSH

SSH server mode runs the LLM-IDE core on a Linux server that you can already log into with SSH. The
desktop installs the core in your home folder on that server, starts it, and reaches it through one
SSH port forward. You do not need a domain, a TLS certificate, root access, systemd or Node.js on the
server.

This is the third server mode. The other two are **Local desktop** (the core runs on this computer)
and **Remote server** (an LLM-IDE hub you connect to, see [Connect the desktop to a server](configure-remote-server.md)).

> The feature has not been tested on a real server yet. Read the [limits](#limits) before you rely on it.

## What you need

- A Linux server on the x86_64 architecture, with at least 2 GB of free disk in your home folder.
- An SSH login on that server: a host name or IP address, a port (usually `22`), a user name, and either
  a private key file on this computer or the account password.
- Optional: the Claude CLI installed on the server and signed in with `claude login`. Without it the
  core runs, but Claude features do not work. See [Claude on the server](#claude-on-the-server).

## Connect

1. Open **Settings → Server & Backend → SSH server**.
2. Enter the server's **Host**, **Port** and **User**.
3. Choose how you log in: **Key file** (enter the absolute path to the private key, for example
   `/Users/alice/.ssh/id_ed25519`) or **Password**.
4. Press **Test**. The app connects only to read the server's host key and shows its fingerprint.
   Nothing is installed yet.
5. Compare the fingerprint with the one the server's operator gives you, then press **Trust this key**
   and confirm the dialog. The app saves the key and refuses any other key for this server from now on.
6. Press **Test** again. The app logs in and shows what it found: the operating system and architecture,
   the free disk space, the installed core version, and whether the Claude CLI is installed. With
   password login, this step asks for the password.
7. Press **Connect**. The app uploads the core only when the server's current release is another version,
   checks the upload's SHA-256 on the server, starts the core, opens the forward and checks that the core
   it reached is the one it started.

If the app was in **Local desktop** or **Remote server** mode, Connect saves SSH server mode and asks you
to restart. The new mode applies at the next start of the app.

## Login methods

### Key file

The app uses only the key you named, not an agent or a default key. `ssh` never prompts in this mode, so
a key that needs a passphrase fails to log in. The app passes the key path to the system `ssh` and never
copies the key.

### Password

The password is typed in the app and kept in memory for this run of the app only. It is never saved in
the app's settings, the OS keychain, a log, a command line or an environment variable. The app hands it to
the system `ssh` through a one-time helper. Reconnects during the same run reuse it. After you restart the
app, a password connection asks for the password again.

The password is used for Test (after the key is trusted), Connect, Stop server and Uninstall.

### Switch from a password to a key

While you are connected with password login, press **Use a key from now on**. The app then:

1. creates an ed25519 key on this computer, in the `ssh` folder under the app's data folder;
2. adds the public line to `~/.ssh/authorized_keys` on the server;
3. logs in with the new key to check it;
4. only after the check passes, saves key login as the login method.

If any step fails, the saved login method stays as it was (password), and the app removes the new key files
on this computer. The server may keep the public line, which does nothing without the private key.

## Disconnect, stop and uninstall

These three actions do different things. The server core keeps running until you stop it.

| Action | Effect on this computer | Effect on the server |
|---|---|---|
| **Disconnect** | Closes the forward. | Nothing. The core keeps running. |
| **Stop server** | Closes the forward. | Stops the core. |
| **Uninstall…** | Closes the forward. | Stops the core and removes the installed releases. Your data is kept. You must type the server's host name to confirm. |

The core also keeps running after you quit the desktop app. When you open the app again with key login, it
reconnects to the running core without a new upload. With password login it asks for the password first.

## What happens on the server

The desktop uses one folder on the server:

```text
~/.llmide-server/
  releases/<version>/   the installed core (one folder per version)
  current               symbolic link to the release that runs
  data/                 your database and plugins; kept by Uninstall
  state.json            pid, port, version and the per-start health nonce
  core.log              the core's log
```

Folders are private to your user (mode `0700`) and files are private too (mode `0600`).

The core listens on `127.0.0.1` only, on the first free port from `3460` to `3479`. Nothing listens on a
public address. The desktop's end of the forward is one of `127.0.0.1:3456` to `127.0.0.1:3459`, the same
ports the app already allows for the local core.

The core starts detached from the SSH session, so it does not stop when the SSH connection drops. The
desktop never sends a stop signal to it, except through **Stop server** or **Uninstall**.

When the connection drops, the app reopens the forward after 1, 2, 4 and 8 seconds, then every 15 seconds,
and checks the core's identity each time. The core is not affected.

An update that does not start is undone. If the new release does not answer its health check, the app
stops it, points `current` back at the previous release, and starts the previous release again if a core
was running before the update.

## Secrets

The desktop sends its own core secrets (the JWT secret, the vault key and the host approval key) to the
server core over the SSH channel's standard input each time the core starts. They never appear in a command
line or an environment variable of the server's start script, and they are not written to the server's disk.

The per-start health nonce is written to `state.json` on the server (mode `0600`). It identifies the core to
the desktop. It is not one of the secrets above.

One server account belongs to one desktop install. If another desktop finds a core it did not start, it
refuses to touch it and shows `Another computer started the server on this account…`. Use one desktop per
server account.

## Claude on the server

The core uses the Claude CLI that is installed on the server. Install it there, then run `claude login` on
the server. If the core holds a Claude API key for your account, that key is used before the server's CLI. The
app looks for the CLI in
the server's login `PATH`, and also in `~/.local/bin`, `~/.npm-global/bin`, `~/.claude/local` and
`/usr/local/bin`.

## Limits

- **Linux x86_64 only.** Other systems are refused before anything is installed.
- **2 GB of free disk.** Test shows the free space, and Connect refuses a server with less than 2048 MB free.
- **glibc version.** The standard server bundle needs glibc 2.34 or newer. Servers such as Ubuntu 20.04
  (glibc 2.31) need the *compat* bundle, which is built for glibc 2.28. See the "SSH server mode" section of `desktop/PACKAGING.md`.
- **The bundle is not in the installer yet.** In this version the server bundle is read from a development
  checkout (`desktop/resources/hub/` or `desktop/dist/hub/`), or from the app's resources if a build put it
  there. It is not downloaded and it is not shipped inside the installer. A build without a bundle shows
  `This build has no Linux server bundle.`
- **Sections.** In SSH server mode the app shows Home, Issues, Gantt, Library, Chat and Settings. Files,
  Changes, Terminal, opening a server folder as a project, and Loop on the server are planned and not
  available yet.
- **Shared servers.** Another user on the same server can reach the core's loopback port. The core's own
  sign-in is what stops them from using it.
- **Web and iPhone.** They cannot reach a core in SSH server mode.

## Troubleshooting

Each row starts with the exact sentence the app shows.

| Message | Cause | What to do |
|---|---|---|
| `The server refused this login.` | The key or password was rejected. | Check the user name, the key path (absolute) or the password. |
| `Enter the password for this server.` | Password login is selected and no password was entered. | Type the password and try again. |
| `Could not reach the server.` | The host, the port or the network is wrong, or SSH does not answer. | Check the host, port, firewall and that `ssh` works from a terminal on this computer. |
| `Test the connection and confirm the server's host key first.` | No host key is trusted yet, or the saved key belongs to another host or port. | Press Test, compare the fingerprint, and press Trust this key. |
| `The server's host key changed. Test the connection again and confirm the new fingerprint.` | The server presents a different host key than the one you trusted. This can mean a reinstalled server or an attack. | Ask the server's operator for the new fingerprint. Test again and trust it only if it matches. |
| `Another computer started the server on this account. This version supports one desktop per server account.` | A core this desktop did not start is running for this account. | Press Stop server on the desktop that started it, then connect again from this one. |
| `This build has no Linux server bundle.` | The app build does not contain the server bundle. | Use a development build made with `node desktop/scripts/stage-hub-core.mjs` (see `desktop/PACKAGING.md`). |
| `the server runs <OS>; only Linux is supported` | The server is not Linux. | SSH server mode needs a Linux server. |
| `the server is <arch>; only x86_64 is supported` | The server is not 64-bit Intel or AMD. | Use an x86_64 server. |
| `only <N> MB free on the server; at least 2048 MB are needed` | Not enough disk space in the home folder. | Free space, then test again. |
| `the server could not start the core (<reason>)` | The core did not start. The reason is one of `timeout`, `exited`, `invalid`, `no-port` or `version-mismatch`. For `exited`, the message ends with the core's last log line. | Read `~/.llmide-server/core.log` on the server. A glibc error there means the server needs the compat bundle. |
| `the port forward to the server stopped` | The SSH forward ended. The app reconnects with a delay. | Wait for the reconnect. If it keeps failing, check the network. |
| `no local port in 3456..=3459 is free for the forward` | Four local ports are busy. | Close the program that uses them, then connect again. |
| `The server core is not running. Connect again to start it.` | The core was stopped on the server. | Press Connect. |
| `A different core is running on the server now, so it was left alone.` | Another core took the server's port or replaced this one while the app was connected. | Stop server, then connect again. |
| `The server did not accept the new key. Your password login is unchanged.` | The key check failed. | Connect with the password and try Use a key from now on again. |
| `Type the server's host name to uninstall.` | The confirmation text does not match the saved host. | Type the saved host name exactly. |

To see what the server is running, read `~/.llmide-server/state.json` and `~/.llmide-server/core.log` on the
server.

## Related

- [Connect the desktop to a server](configure-remote-server.md) — the hub mode
- [Install a server](install-a-server.md) — the one-command Ubuntu/Debian installer for a hub
- `desktop/PACKAGING.md`, section "SSH server mode" — packaging and bundle notes for engineers
