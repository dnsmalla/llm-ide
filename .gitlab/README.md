# LLM-IDE — Desktop App, Local Core and Chrome Extension

LLM-IDE is a local-first AI workspace for engineering teams. It captures meetings and other sources
into a searchable library, plans work from that library, and automates code review and
implementation — with every outbound action (pull requests, tickets, messages) gated on your approval.

This repository contains the **desktop application** (including **SSH server mode**), the **local
Node core** that powers it, and the **Chrome extension** for meeting capture.

> **Mirror notice.** This project is a one-way, read-only mirror of a subset of the main LLM-IDE
> repository. It is updated automatically on every change to the upstream `main` branch.
> Commits pushed here are overwritten, so please do not push to it. Report issues or propose
> changes to the maintainer instead.

## Contents

- [Components](#components)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [SSH server mode](#ssh-server-mode)
- [Building a release](#building-a-release)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Testing](#testing)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)
- [License](#license)

## Components

| Component | Technology | Purpose |
|:--|:--|:--|
| **Desktop app** | Tauri 2 (Rust host) + React, TypeScript, Vite | The main workspace: Library, Explorer with Code Assistant, Issues, Gantt, Graph, Auto Tasks, Loop and Settings. Starts and supervises the core. macOS, Windows and Linux. |
| **Local core** | Node.js 22, pure HTTP (no framework), SQLite (WAL + FTS5) | Authentication, knowledge base, AI orchestration, guardrails and integrations. Listens on `127.0.0.1:3456`. |
| **SSH server mode** | Rust host + a helper deployed over SSH | Runs the core on a Linux server you can already log in to, reached through a single SSH port forward. |
| **Chrome extension** | React 18 + TypeScript, Manifest V3 | Captures live captions from Google Meet, Microsoft Teams and Zoom (web) and shows notes in a side panel. |

Model calls go through the user's signed-in **Claude CLI** by default; per-user API keys are kept
in an encrypted vault. Integrations include GitHub, GitLab, Backlog, Linear, Slack, Box and MCP
connectors.

## Requirements

| Tool | Version | Notes |
|:--|:--|:--|
| Node.js | 22 or later | Core, extension and desktop front end |
| Rust | 1.90 or later | Desktop host (`desktop/src-tauri`) |
| Git | any recent | Submodules are used |
| Claude CLI | latest | Sign in once with `claude login` |

On macOS, the Xcode Command Line Tools are also required. On Linux, install the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your distribution.

## Getting started

### 1. Clone and install

```bash
git clone --recurse-submodules git@gitlab.com:grid-devs/personal/dinesh/llm-ide-app.git
cd llm-ide-app
./setup.sh        # checks prerequisites and installs all dependencies; safe to re-run
```

If you cloned without `--recurse-submodules`, run `git submodule update --init --recursive graph-kit`
before `./setup.sh`. The `graph-kit` submodule (the graph engine) is public.

### 2. Build and install the desktop app (macOS)

```bash
scripts/build-desktop-mac.sh                       # about 3 minutes warm; longer on the first run
ditto desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app /Applications/LLM-IDE.app
open /Applications/LLM-IDE.app
```

The script stages the core, builds the app, signs it (with your Apple Development identity if you
have one, otherwise ad-hoc), and smoke-tests the bundled core. It does **not** install the app:
copy it to `/Applications` yourself after every build, or you will keep running the old copy.
Add `--dmg` to also produce a disk image. On Windows and Linux, run `node scripts/stage-core.mjs`
and `npm run tauri build` in `desktop/` (see [Building a release](#building-a-release)).

### 3. Or run it in development mode

```bash
cd desktop
npm run tauri dev   # opens the app window with live reload; the app starts its own core
```

### 4. Run the core on its own (optional)

```bash
cd extension
npm run server      # http://127.0.0.1:3456 — check with: curl http://127.0.0.1:3456/health
```

### 5. Load the Chrome extension (optional)

```bash
cd extension
npm run build       # writes extension/dist/
npm run server      # the extension talks to the local core
```

Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select
`extension/dist/`.

## SSH server mode

SSH server mode runs the LLM-IDE core on a Linux server and uses it from the desktop app on your
own computer. The desktop installs the core into your home folder on the server, starts it, and
connects through one SSH port forward. The server needs no domain, TLS certificate, root access,
systemd or Node.js.

**Server requirements**

- Linux on x86_64 with at least 2 GB free in your home folder
- An SSH login (host, port, user, and a key file or password)
- A POSIX login shell (bash, dash, zsh or ksh) and the `sha256sum`, `tar` and `setsid` commands
- Optional: the Claude CLI installed on the server and signed in, for AI features

**Connect**

1. In the desktop app, choose **Connect to SSH server** on the Welcome screen, or open
   **Settings → Server & Backend** and select **SSH server**.
2. Enter the host, port, user and login method, then press **Connect**.
3. On first contact, compare the shown host-key fingerprint and press **Trust this key**.
4. The app installs or updates the server part, starts it, and switches to SSH server mode for
   this session.

The host code lives in `desktop/src-tauri/src/ssh_*.rs`; local and remote workspace logic is shared
in `desktop/workspace-core`.

## Building a release

The release bundle embeds a staged copy of the core. **Always stage the core first**; otherwise
the build ships an outdated core.

```bash
cd desktop
node scripts/stage-core.mjs
npm run tauri build
```

On macOS, `scripts/build-desktop-mac.sh` stages the core and builds the app in one step.
Packaging, signing and platform notes: [desktop/PACKAGING.md](desktop/PACKAGING.md) and
[desktop/RUN-ON-MAC.md](desktop/RUN-ON-MAC.md).

## Architecture

```text
┌───────────────────────── Desktop app (Tauri) ─────────────────────────┐
│  React screens (ui/)  ◀──── invoke ────▶  Rust host (desktop/src-tauri) │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ spawns + supervises (local mode)
                                    │ or SSH port forward (SSH mode)
                                    ▼
Chrome extension ──HTTP──▶  Local core (extension/, 127.0.0.1:3456)
                              ├─ routes/      HTTP API
                              ├─ kb/          SQLite (WAL + FTS5), per-user rows
                              ├─ agents/      planner, risk, codegen, dispatcher
                              ├─ providers/   Claude CLI / API model dispatch
                              └─ connectors/  GitHub, GitLab, Slack, Box, …
```

Key design decisions:

- **Local-first.** The core binds to `127.0.0.1`; data lives in one SQLite database per install.
- **No web framework.** The core uses plain Node HTTP to keep the dependency surface small.
- **Per-user tenancy.** Every owned row carries a `user_id`, and search results are re-checked
  against it.
- **Append-only migrations.** Schema changes are numbered SQL files under `extension/kb/migrations/`.
- **Layered modules.** Import boundaries inside `extension/` are enforced by ESLint.

## Repository layout

```text
llm-ide-app/
├── desktop/         Tauri desktop app
│   ├── src-tauri/       Rust host: commands, core supervision, SSH mode
│   ├── workspace-core/  Shared local + SSH workspace logic
│   └── workspace-helper/ Linux helper serving Explorer file/git/search on SSH servers
├── ui/              React screens and the shared UI kit used by the desktop
├── extension/       Local Node core (server.mjs, routes/, kb/, agents/, providers/)
│                    and the Chrome extension (src/)
├── schema/          Wire contracts (HTTP, Host API, sync) and fixtures
├── graph-kit/       Graph engine (git submodule)
├── deploy/hub/      Server templates used by the desktop's remote deployment
├── scripts/         Setup, code generation and verification scripts
├── setup.sh         One-shot developer setup
└── Makefile         Test and lint entry points
```

## Testing

```bash
make test                       # core and extension tests (Node test runner)
make lint                       # ESLint + Prettier check for extension/
make test-desktop ALLOW_SKIP=1  # desktop + ui tests, then cargo tests when Rust is installed
make typecheck-desktop          # TypeScript check of the desktop and its screens
```

`ALLOW_SKIP=1` is required in this repository because some upstream test targets cover parts that
are not mirrored here (the web and iPhone apps).

## Security model

- **Loopback only.** The core listens on `127.0.0.1`; a remote bind must be enabled explicitly.
- **Strict origins.** CORS allows only the extension and `localhost`, and requests with a
  non-loopback `Host` header are refused (DNS-rebinding protection).
- **Secrets stay encrypted.** API keys and tokens are stored in an encrypted vault or the OS keychain.
- **Human approval.** Pull requests, tickets and messages are sent only after you approve them;
  generated diffs pass a guardrail scan first.
- **Verified SSH hosts.** SSH server mode pins the server's host key on first use.

## Troubleshooting

| Problem | Solution |
|:--|:--|
| `Cannot find module …` or other npm errors | Run `./setup.sh` again |
| `Node.js 22+ is required` | Install Node.js 22 or later |
| `cargo: command not found` | Install Rust from [rustup.rs](https://rustup.rs), open a new shell, run `./setup.sh` |
| `Port 3456 already in use` | Find the process with `lsof -i :3456`, stop it, then start the core again |
| Build fails with `Could not load …/three.module.js` | The `graph-kit` submodule is missing: `git submodule update --init --recursive graph-kit`, then `./setup.sh` |
| Extension does not load or is out of date | `cd extension && npm run build`, then reload it at `chrome://extensions` |
| A built app runs an old core | Run `node scripts/stage-core.mjs` in `desktop/` before `npm run tauri build` |

## Further reading

| Topic | Document |
|:--|:--|
| Desktop development | [desktop/README.md](desktop/README.md) |
| Packaging and releases | [desktop/PACKAGING.md](desktop/PACKAGING.md) |
| Building on macOS | [desktop/RUN-ON-MAC.md](desktop/RUN-ON-MAC.md) |
| Core internals, sync and invariants | [extension/CLAUDE.md](extension/CLAUDE.md) |

## License

Released under the [MIT License](LICENSE).
