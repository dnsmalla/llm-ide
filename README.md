# LLM-IDE

> A local-first AI workspace. Capture meetings and sources, plan in a searchable library, automate code review and implementation, and send work to GitHub or GitLab when you approve it. Everything runs on your computer unless you allow an outbound action.

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](./extension/package.json)
[![API](https://img.shields.io/badge/wire%20API-v145-green.svg)](./extension/server.mjs)
[![Manifest](https://img.shields.io/badge/manifest-V3-orange.svg)](./extension/manifest.json)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](#license)

## What you can do

- **Capture:** Google Meet, Teams and Zoom captions, live mic, email, Slack, Box, repos and MCP connectors all land in one searchable **Library**.
- **Plan:** search with FTS5, summarize, turn notes into issues, plans and a Gantt view.
- **Automate:** built-in and custom **Auto Tasks** (review, implement, regression, docs) on a schedule, plus **Loop** and the **Factory** board for issue-to-PR runs.
- **Code:** Explorer with a docked Code Assistant, code graph, guardrail-scanned diffs, and PR/ticket dispatch after your approval.
- **Take it with you:** chat, run tasks and start Loop runs from your **iPhone** or browser.
- **Work as a team:** run the same core as an always-online **hub** with invites, roles and per-member limits.

Your data stays in a per-user SQLite store on your machine (or on the hub you run). Model calls use your logged-in **Claude CLI**, or per-user API keys kept in an encrypted vault. Outbound actions (PRs, tickets, Slack) are always opt-in.

<p align="center">
  <img src="docs/assets/system-map.svg" alt="LLM-IDE system map: the Library at the centre, fed by sources and driving automation and visualization" width="860"/>
</p>

## Get started

You need Node 22+, Git and the [Claude CLI](https://docs.claude.com/en/docs/claude-code/quickstart) (`claude login`). The desktop app also needs Rust 1.88+.

```bash
git clone --recurse-submodules git@github.com:dnsmalla/llm-ide.git
cd llm-ide
./setup.sh                      # checks prerequisites, installs everything, safe to repeat
cd desktop && npm run tauri dev # the desktop app starts its own core
```

For the Chrome extension, also run `cd extension && npm run build && npm run server`, then load `extension/dist/` at `chrome://extensions` (Developer mode, **Load unpacked**). First meeting: [Record your first meeting](docs/tutorials/01-first-meeting.md). New machine, after a `git pull`, or something failing: [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md).

## Where to use it

| Surface | Use it for | Start here |
|---------|-----------|------------|
| **Desktop app** (macOS, Windows, Linux) | Everything: Library, Explorer + Code Assistant, Issues, Gantt, Graph, Auto Tasks, Loop, Settings | `cd desktop && npm run tauri dev` · [build the Mac app](desktop/RUN-ON-MAC.md) |
| **Chrome extension** | Capture live captions from Meet, Teams and Zoom (web) and read notes in the side panel | `extension/dist/` |
| **iPhone app** | **Ask** (read-only chat), **Execute**, **Auto Tasks**, **Loop**, History | pair in the desktop's Settings → Phone and browser |
| **Web app** | Chat, history and approvals | `cd web && npm run dev` |
| **Team hub** | The same core on a server you own, for every member | [run a hub](docs/how-to/run-a-hub.md) · [connect the desktop](docs/how-to/configure-remote-server.md) |

**Phone and browser:** in the desktop, Settings → **Phone and browser** has two tabs. **Online** pairs a device for live chat while the desktop is on (PIN and QR). **Offline** sets up encrypted sync storage (your own server, Box or MEGA) so history stays readable when the desktop is off. A phone can start Execute and Loop runs, but every start waits for your approval on the desktop.

**Team and roles:** Settings → Team (owners and admins on a hub): [members](docs/how-to/manage-team-members.md) and [project roles](docs/how-to/project-roles.md).

**Integrations:** GitHub · GitLab (gitlab.com, nested groups) · Backlog · Linear · Slack · Box · MCP connectors · user plugins.

## How it fits together

One Node **core** (`extension/`, pure HTTP on `127.0.0.1:3456`) owns auth, the knowledge base, AI routing and guardrails. The desktop app starts and supervises it. The extension, the web app and the iPhone app talk to it; phones and browsers use a pinned, encrypted **Host API**. More: [architecture](docs/explanation/architecture.md) · [server internals](docs/explanation/server-internals.md) · [engineering invariants](docs/explanation/invariants.md).

```
llm-ide/
├── extension/   Chrome extension + the Node core (server.mjs, kb/, routes/, providers/, agents/)
├── desktop/     Tauri desktop app (Rust host in src-tauri/)
├── ui/          React screens and shared kit used by the desktop and the web app
├── web/         Browser app        ios_app/   iPhone app (SwiftUI + SharedProtocol)
├── deploy/      Team hub deployment (nginx, systemd, backups)
├── graph-kit/ and .skills/   Submodules: graph engine, shared agent skills
├── docs/        Documentation site      scripts/   setup, generators, gates
└── setup.sh     One-shot install
```

## Everyday commands

```bash
cd extension && npm run server       # the core on 127.0.0.1:3456
cd desktop && npm run tauri dev      # desktop app (starts its own core)
make test                            # core tests          make test-desktop   # desktop + Rust
make test-shared-protocol            # iOS wire types      make test-ios-app   # iPhone app tests
make regression                      # the pre-push gate   make lint && make format
make docs-serve                      # docs at localhost:8000   make docs-check
```

Agent and developer guide: [CLAUDE.md](CLAUDE.md). Shared agent skills come from the `.skills` submodule: `bash scripts/install-skills.sh` after a pull.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot find module …" or other npm errors | `./setup.sh` |
| "Node.js 22+ is required" | install Node 22+ ([nodejs.org](https://nodejs.org/) or `brew install node`) |
| "cargo: command not found" | install Rust from [rustup.rs](https://rustup.rs), open a new shell, run `./setup.sh` |
| "Port 3456 already in use" | `lsof -i :3456`, stop that process, start the server again |
| Extension won't load or is out of date | `cd extension && npm run build`, reload it at `chrome://extensions` |
| iPhone tabs missing (Execute, Auto Tasks, Loop) | restart the desktop core and pair the phone again |

More fixes and the full install walk-through: [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md) · [runbooks](docs/runbooks/index.md).

## Documentation

Full site: https://grid-devs.gitlab.io/personal/dinesh/notes-extension/

| Topic | Link |
|-------|------|
| Architecture and invariants | [architecture](docs/explanation/architecture.md) · [invariants](docs/explanation/invariants.md) |
| API | [overview](docs/reference/api/overview.md) · [OpenAPI](docs/reference/api/openapi.yaml) |
| Phone and web | [iPhone quick start](docs/mobile/quick-start.md) · [encrypted sync (ADR 0020)](docs/decisions/0020-box-encrypted-sync.md) |
| Decisions | [docs/decisions/](docs/decisions/) (ADRs 0001–0022) |
| Auto Tasks and Factory | [configure Auto Tasks](docs/how-to/configure-auto-tasks.md) · [Factory demo board](docs/how-to/factory-demo-board.md) |
| Project folder layout | [project-layout](docs/reference/project-layout.md) |
| Contribute | [contribute](docs/how-to/contribute.md) · [naming convention](docs/decisions/0016-naming-convention.md) |

## License

MIT.
