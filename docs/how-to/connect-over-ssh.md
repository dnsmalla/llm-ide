---
title: Connect the desktop to a Linux server over SSH
applies_to: desktop
---

# Connect the desktop to a Linux server over SSH

SSH server mode runs the LLM-IDE core on a Linux server that you can already log into with SSH. The
desktop installs the core in your home folder on that server, starts it, and reaches it through one
SSH port forward. You do not need a domain, a TLS certificate, root access, systemd, Node.js or curl on
the server.

This is the third server mode. The other two are **Local desktop** (the core runs on this computer)
and **Remote server** (an LLM-IDE hub you connect to, see [Connect the desktop to a server](configure-remote-server.md)).

> The connect path was run end to end against one Ubuntu 20.04 server: password login, install, start,
> forward, sign-up and sign-in, disconnect and reconnect, stop, and uninstall. Clicking through the app
> window, key install on a real account, and Windows desktops have not been verified. Read the
> [limits](#limits) before you rely on it.

## What you need

- A Linux server on the x86_64 architecture, with at least 2 GB of free disk in your home folder.
- An SSH login on that server: a host name or IP address, a port (usually `22`), a user name, and either
  a private key file on this computer or the account password.
- A login shell that is POSIX-compatible: bash, dash, zsh or ksh. Fish and csh are not supported.
- The `sha256sum`, `tar` and `setsid` commands on the server, and the usual POSIX utilities.
- Optional: the Claude CLI installed on the server and signed in with `claude login`. Without it the
  core runs, but Claude features do not work. See [Claude on the server](#claude-on-the-server).

## Connect

You can connect from the Welcome screen or from Settings. Both use the same form and the same steps.

### From the Welcome screen

1. Press **Connect to SSH server**, then **Connect…**. The dialog opens over the Welcome screen.
2. Enter the server's details and choose the login method, as described below. The dialog runs the same
   Test and Connect steps as Settings.
3. When the connection works, press **Switch to this server now**, then **Switch** in the confirmation. Only
   that confirmation restarts the app; pressing the first button changes nothing on this computer.

### Recent SSH servers

The Welcome screen lists up to 10 saved servers, most recent first. **Connect** on a row connects at once for
a key login. A password login opens the dialog and asks only for the password. **Edit** opens the dialog
filled in. **Forget** removes the server, its recent folders, and its saved host key, unless another saved
server uses the same host.

### From Settings

1. Open **Settings → Server & Backend → SSH server**.
2. Enter the server's **Host**, **Port** and **User**. Use the real host name or IP address. A host alias
   from `~/.ssh/config` cannot be used: the app's key scan cannot resolve it.
3. Choose how you log in: **Key file** (enter the absolute path to the private key, for example
   `/Users/alice/.ssh/id_ed25519`) or **Password**.
4. Press **Test**. The app connects only to read the server's host key and shows its fingerprint.
   Nothing is installed yet.
5. Compare the fingerprint with the one the server's operator gives you, then press **Trust this key**
   and confirm the dialog. The app saves the key and refuses any other key for this server from now on.
6. Press **Test** again. The app logs in and shows what it found: the operating system and architecture,
   the free disk space, the installed core version, and whether the Claude CLI is installed. The app checks
   only that `claude --version` runs, not that you are signed in. With password login, this step asks for
   the password.
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

These three actions do different things. The server core keeps running until you stop it, or until a
connect after an app update replaces it with the new version (see [Updates](#updates)).

| Action | Effect on this computer | Effect on the server |
|---|---|---|
| **Disconnect** | Closes the forward. | Nothing. The core keeps running. |
| **Stop server** | Closes the forward. | Stops the core. |
| **Uninstall…** | Closes the forward. | Stops the core and removes the installed releases. Your data is kept. You must type the server's host name to confirm. |

Stop server and Uninstall act on the saved server. Stop server refuses a form whose Host, Port or User differ
from the saved server, with `Those are not the saved server's details.` Uninstall compares only the host
name you type in its confirmation with the saved host, and refuses another name with
`Type the server's host name to uninstall.` If the core was started by another desktop, both refuse and
offer **Stop it anyway** or **Uninstall anyway**. Use those only when you know the other desktop's work can
stop.

The core also keeps running after you quit the desktop app. When you open the app again with key login, it
reconnects to the running core without a new upload. With password login it asks for the password first.

To delete the server's data after Uninstall, remove the folder by hand on the server:
`rm -rf ~/.llmide-server`. The app keeps it on purpose, so the database survives a reinstall.

## Work on the server

After you switch to the server, the Welcome screen shows the server home instead of the local project list.

### Server home

The server home shows the connection state, with **Disconnect** and **Stop server**, and the server's user, the
core version and the Claude CLI version. When the link needs a password, a password field appears on this
screen. **Open folder…** is available only while the link is connected. Below it, the page lists up to 10
recent folders on this server. A folder that is no longer there is marked `This folder is no longer on the server.`
and has a **Remove** button. **Continue** appears when a folder is open and returns you to the app's home section.

### Folder picker

**Open folder…** shows the folders on the server, starting at the server user's home folder. The picker has
breadcrumbs, a **Show hidden** check box and **New folder** (the name is checked before it is created). Double-click
a folder to enter it. **Open** opens the selected folder, and **Open this folder** opens the current one.
You cannot go above the home folder. A symbolic link that points outside the home folder is listed with
`link`, but you cannot enter or open it. Opening a folder registers it with the server core, so the core's
project list has it.

### Explorer and terminal

With a server folder open, the sidebar lists Home, Issues, Gantt, Library, Chat, Settings and Explorer. Explorer
reads and writes files, searches, watches for changes and shows **Changes** (git) on the server. Its terminal
opens your login shell on the server, in the open folder. Each terminal tab is its own SSH session, so a
tab keeps running while the file commands reconnect.

When no approval is active, opening a terminal asks **Allow terminal access?**. Press **Allow terminal**. That
approval lets new terminals open for 30 minutes. A terminal is a real shell with your server user's permissions.

Explorer commands never touch this computer's files. Commands that act on this computer, such as opening a PDF
in its viewer, showing a folder dialog on this computer, or creating or cloning a local project, are refused in
SSH mode.

### Deleting files

Deleting in Explorer moves the item to the server's Trash. On Linux the helper uses the freedesktop Trash
(normally `~/.local/share/Trash` on the server). If the server has no usable Trash, the delete fails with
`cannot move to trash` and the item stays where it was. Nothing is deleted permanently.

### git on the server

**Changes** uses the server's `git`, with the server user's identity and credentials. If `git` is not installed
on the server, the panel shows `git is not installed on this server.` The rest of Explorer still works. Explorer
has no `git init`, so run it in the terminal.

### The helper

The file, git, search and watch commands run in a helper program on the server:
`~/.llmide-server/current/core/bin/llmide-workspace`. It is installed with each server release, so its version
matches the desktop. The desktop starts it over one SSH channel and talks to it on standard input and output.
It has no network listener, and it ends when the channel closes. It refuses any folder outside the server user's
home folder, and it checks that again on every request. If the server part is a different version from the
desktop, the desktop shows `The server part is a different version. Connect again to update it.`; Connect
installs the matching release.

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

### One core per data folder

Only one core runs for each data folder, and only one start runs at a time. A start takes the lock folder
`~/.llmide-server/.start.lock` before it reads the state, and removes it when it ends. A lock whose holder
has exited is reclaimed automatically. If a start is already running, Connect says
`The server is already starting. Try again in a moment.`

### Environment

The core starts with an empty environment and a short allow-list: your home folder, user name, shell,
locale, time zone, temporary folder, proxy and certificate settings, and the `PATH` that finds the
Claude CLI. Other variables that your server login exports do not reach the core, so a provider API key
in your shell profile is not passed to it. Sign in to the Claude CLI on the server (`claude login`).

### Health check

After it starts, the core must answer `/health` with the nonce the desktop sent. The check uses the
bundled Node.js, so the server does not need curl. A core that does not answer in about 20 seconds is
stopped, and its state is removed.

The core starts detached from the SSH session, so it does not stop when the SSH connection drops. If the
connection drops during a start, the core can keep running and recorded in `state.json`. The desktop
records each start's nonce before it sends the start, so the next Connect from the same desktop finds that
core, confirms it with STATUS, and reuses it without a second start. Another desktop does not reuse it: it
refuses the core as foreign. The desktop never sends a stop signal to the core, except through **Stop
server**, **Uninstall** or the update described below.

When the connection drops, the app reopens the forward after 1, 2, 4 and 8 seconds, then every 15 seconds,
and checks the core's identity each time. The core is not affected.

### Updates

After an app update that brings a new core version, the first connect stops the running core and starts
the new one. You do not need to press **Stop server** first. If the new release does not answer its health
check, the app stops it, points `current` back at the previous release, and starts the previous release
again if a core was running before the update.

A rebuilt core with the same version number is replaced the same way on the next connect. The app compares the
SHA-256 of its bundle with the one recorded for the server's release, so a new build of the same version does not
stay unused. If that new release does not answer its health check, it is left stopped, because no earlier
release of that version exists to return to.

Each release is large, so the app keeps only the current release and the one before it. Older release folders are removed after an update succeeds.

## Secrets

The desktop sends its own core secrets (the JWT secret, the vault key and the host approval key) to the
server core over the SSH channel's standard input each time the core starts. They never appear in a command
line or an environment variable of the server's start script, and they are not written to the server's disk.

The server core receives these secrets in its memory, so an administrator of the server (root, or anyone
who can read the process memory) can read them. Connect only to a server whose administrator you trust with
this desktop's data.

The per-start health nonce is written to `state.json` on the server (mode `0600`). It identifies the core to
the desktop. It is not one of the secrets above.

One server account belongs to one desktop install. If another desktop started the core, Connect refuses to
use it and shows `Another computer started the server on this account.` Stop server and Uninstall refuse
the same way. **Stop it anyway** and **Uninstall anyway** repeat the action on purpose. Use one desktop per
server account.

## Claude on the server

The core uses the Claude CLI that is installed on the server. Install it there, then run `claude login` on
the server. If the core holds a Claude API key for your account, that key is used before the server's CLI.
The app looks for the CLI in the server's login `PATH`, and also in `~/.local/bin`, `~/.npm-global/bin`,
`~/.claude/local` and `/usr/local/bin`. It checks only that `claude --version` runs. Claude features do not
work until `claude login` succeeds on the server.

## Limits

- **Verification.** The connect path was run end to end against one Ubuntu 20.04 server: password login,
  install, start, forward, sign-up and sign-in, disconnect and reconnect, stop, and uninstall. Clicking
  through the app window, key install on a real account, and Windows desktops have not been verified.
- **Linux x86_64 only.** Other systems are refused before anything is installed.
- **2 GB of free disk.** Test shows the free space, and Connect refuses a server with less than 2048 MB free.
- **glibc version.** The standard server bundle needs glibc 2.34 or newer. Servers such as Ubuntu 20.04
  (glibc 2.31) need the *compat* bundle, which is built for glibc 2.28. The app reads the server's glibc
  version and refuses the standard bundle on an older server. See the "SSH server mode" section of
  `desktop/PACKAGING.md`.
- **The bundle is not in the installer yet.** In this version the server bundle is read from a development
  checkout (`desktop/resources/hub/` or `desktop/hub-dist/`), or from the app's resources if a build put it
  there. It is not downloaded and it is not shipped inside the installer. A build without a bundle shows
  `This build has no Linux server bundle.`
- **Sections.** In SSH server mode the app shows Home, Issues, Gantt, Library, Chat, Settings and Explorer.
  Explorer's files, search, Changes (git), watching and terminal run on the server. Loop on the server is not
  available yet, and neither are the other screens that read this computer's files or run its processes.
- **Explorer on the server.** Deletes go to the server's Trash, and nothing is deleted permanently. Opening a
  PDF in this computer's viewer and local project create or clone are refused. Explorer has no `git init`.
- **Other users on the server.** Other users on the same server can reach the core's loopback port. The
  core lets only its first account register; later sign-ups need an invite from the owner, and every
  sign-in still needs a valid account. Until the first account exists, another account on the server could
  create it first and own the core. Create your account right after the first connect.
- **Link only while connected.** The desktop sends no requests through the forward while the link is
  reconnecting. Requests wait until it is connected again.
- **Host names.** Use the real host name or IP address. A host alias from `~/.ssh/config` cannot be used.
- **Web and iPhone.** They cannot reach a core in SSH server mode.

The first account created on the server core becomes its owner. After that, further sign-ups are refused
without an invite, and the sign-in screen stops offering sign-up. An invite from the owner still lets a
new account in. The server core is started in this single-owner mode (`LLMIDE_REGISTRATION_SINGLE_OWNER=1`).

## Troubleshooting

Each row starts with the exact sentence the app shows.

| Message | Cause | What to do |
|---|---|---|
| `The server refused this login.` | The key or password was rejected. | Check the user name, the key path (absolute) or the password. |
| `Enter the password for this server.` | Password login is selected and no password was entered. | Type the password and try again. |
| `Could not reach the server.` | The host, the port or the network is wrong, or SSH does not answer. | Check the host, port, firewall and that `ssh` works from a terminal on this computer. |
| `The server did not answer in time.` | A command on the server or the network took too long. | Check the server's load and the network, then try again. |
| `Test the connection and confirm the server's host key first.` | No host key is trusted yet, or the saved key belongs to another host or port. | Press Test, compare the fingerprint, and press Trust this key. |
| `The server's host key changed. Test the connection again and confirm the new fingerprint.` | The server presents a different host key than the one you trusted. This can mean a reinstalled server or an attack. | Ask the server's operator for the new fingerprint. Test again and trust it only if it matches. |
| `Another computer started the server on this account.` | A core this desktop did not start is running for this account. | Use the desktop that started it. Press **Stop it anyway** or **Uninstall anyway** only if you are sure that work can stop. |
| `Those are not the saved server's details.` | The Host, Port or User in the form differ from the saved server, so Stop server refused to act. | Put back the saved values to stop that server. To use other values, connect to them first. |
| `The server is already starting. Try again in a moment.` | Another start of the core is running for this data folder. | Wait a moment, then press Connect again. |
| `The local port for this server is in use. Quit the other program and connect again.` | Another program took one of the local ports `3456` to `3459` for the forward. | Quit that program, then connect again. |
| `This build has no Linux server bundle. Build it with: node desktop/scripts/stage-hub-core.mjs --compat-sqlite <module> …` | The app build does not contain the server bundle. | Build it with the command the message shows; it is written to `desktop/hub-dist/`. See `desktop/PACKAGING.md`. |
| `the server runs <OS>; only Linux is supported` | The server is not Linux. | SSH server mode needs a Linux server. |
| `the server is <arch>; only x86_64 is supported` | The server is not 64-bit Intel or AMD. | Use an x86_64 server. |
| `only <N> MB free on the server; at least 2048 MB are needed` | Not enough disk space in the home folder. | Free space, then test again. |
| `This server's system libraries are too old for the standard server bundle (glibc <x.y>; 2.34 needed). Build the compatible bundle and try again.` | The server's glibc is older than 2.34, so the standard bundle cannot load there. | Build the compat bundle (see `desktop/PACKAGING.md`), then try again. |
| `This folder is no longer on the server.` | The open folder was deleted, renamed or replaced on the server. The app shows the server home. | Open the folder again from the picker, or remove it from the recent folders. |
| `The connection to the server was lost.` | The channel to the server's helper ended, so a file, git, search or watch request failed. The folder stays open. | Try the action again; the app reconnects on the next request. If it keeps failing, press **Connect** again. |
| `The server part is a different version. Connect again to update it.` | The helper on the server is not the version this desktop was built with. | Press **Connect**. It installs the matching release and then works as usual. |
| `git is not installed on this server.` | The server has no `git`, so **Changes** cannot run. | Install `git` on the server, then reopen the folder. |
| `cannot move to trash: <reason>` | The server has no usable Trash, so the delete was refused and nothing was removed. | Remove the item in a terminal on the server, or from the server's own tools. |
| `The upload was damaged. Try again.` | The core upload did not match its checksum on the server. | Connect again. |
| `The server could not unpack the bundle.` | The uploaded bundle could not be unpacked on the server. | Build the bundle again and connect again. |
| `the server could not start the core (<reason>)` | The core did not start. The reason is the script's result word: `timeout`, `exited`, `invalid`, `no-port`, `version-mismatch`, `pin-failed`, `state-failed` or `lock-failed`. For `exited`, the message ends with the core's last log line. | Read `~/.llmide-server/core.log` on the server. A glibc error there means the server needs the compat bundle. |
| `the port forward to the server stopped` | The SSH forward ended. The app reconnects with a delay. | Wait for the reconnect. If it keeps failing, check the network. |
| `no local port in 3456..=3459 is free for the forward` | Four local ports are busy. | Close the program that uses them, then connect again. |
| `The server core is not running. Connect again to start it.` | The core was stopped on the server. | Press Connect. |
| `A different core is running on the server now, so it was left alone.` | Another desktop started a core on this account while this app was connected, so the server's core is no longer the one this app started. | Press **Stop server**. It answers `Another computer started the server on this account.` with **Stop it anyway**. That button stops the other desktop's core, so press it only when you are sure that work can stop. Then connect again. |
| `The server core is not answering. Stop the server and connect again.` | The forward stayed up, but the core did not answer its health check with its nonce on five reconnect attempts in a row. | Press **Stop server**, then Connect. If Stop server asks for **Stop it anyway**, another desktop started this core: see the row above. |
| `The server did not accept the new key. Your password login is unchanged.` | The key check failed. | Connect with the password and try Use a key from now on again. |
| `Type the server's host name to uninstall.` | The confirmation text does not match the saved host. | Type the saved host name exactly. |

To see what the server is running, read `~/.llmide-server/state.json` and `~/.llmide-server/core.log` on the
server.

## Related

- [Connect the desktop to a server](configure-remote-server.md) — the hub mode
- [Install a server](install-a-server.md) — the one-command Ubuntu/Debian installer for a hub
- `desktop/PACKAGING.md`, section "SSH server mode" — packaging and bundle notes for engineers
