# LLM-IDE

> Local-first AI workspace — capture meetings and sources, plan in a searchable library, automate code review and implementation, and dispatch to GitHub/GitLab/tickets. Everything runs on `127.0.0.1` unless you approve an outbound action.

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](./extension/package.json)
[![API](https://img.shields.io/badge/wire%20API-v39-green.svg)](./extension/server.mjs)
[![Manifest](https://img.shields.io/badge/manifest-V3-orange.svg)](./extension/manifest.json)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](#license)

## What this is

A **Chrome extension**, **native macOS app**, **iPhone companion**, and **local Node server** that share one knowledge base and per-user SQLite store. Capture from meetings, email, Slack, and files; search and plan; run scheduled **Auto Tasks** (review, implement, regression, doc gen, **Loop Engineering**); visualize code and issues; dispatch work when you approve it.

**Local by default.** Data and AI orchestration stay on your machine. Optional per-user API keys (Claude, OpenAI, Google, OpenAI-compatible) live in an encrypted vault; when none are set, the server falls back to your logged-in **Claude CLI**. Outbound dispatch (PRs, tickets, Slack) is always opt-in.

## System at a glance

**Library is the hub.** Every source (meetings, email, Slack, Box, repos, MCP connectors) lands in the KB. From there you search, plan, automate, visualize, and dispatch — all on `127.0.0.1`.

<p align="center">
  <img src="docs/assets/system-map.svg" alt="LLM-IDE system map: Library hub with Sources, Automation, and Visualize &amp; control" width="920"/>
</p>

<p align="center">
  <img src="docs/assets/data-flow.svg" alt="LLM-IDE pipeline: Capture → Library → Plan → Automate → Dispatch → Outcomes" width="860"/>
</p>

| Pillar | What you get | Mac | Extension | iPhone |
|--------|----------------|-----|-----------|--------|
| **Sources** | Meet · Teams · Zoom · live mic · **Email** · **Slack** · Box · **MCP** → notes in Library | ✅ full ingest | ✅ web CC capture | — |
| **Library** | Unified notes, code, data, plugins · FTS5 search · re-summarize | ✅ hub | ✅ meetings | — |
| **Automation** | **13 built-in Auto Tasks** + **custom tasks** (review/implement mode, per-task cron) · **Loop Engineering** | ✅ run + configure | — | ✅ monitor + run |
| **Code** | Explorer chat, codegen, workflows, guardrails, PR/ticket dispatch · **SCIP** symbol graph | ✅ | — | ✅ Explorer |
| **Visualize** | **Code graph**, **Issues**, **Gantt**, **Visual**, conflicts, **Loop Engineering** | ✅ | — | — |
| **Control** | Source control, search, live session, settings, mobile pairing | ✅ | side panel | companion |

```mermaid
flowchart LR
  subgraph sources [Sources]
    M[Meet Teams Zoom]
    E[Email]
    S[Slack]
    L[Live mic]
    MCP[MCP connectors]
  end
  LIB[(Library + KB)]
  subgraph auto [Automation]
    AT[Auto Tasks]
    LE[Loop Engineering]
    CT[Custom tasks]
    CG[Code generation]
  end
  subgraph viz [Visualize and control]
    G[Code graph]
    I[Issues]
    GN[Gantt]
    V[Visual]
    EX[Explorer]
  end
  M --> LIB
  E --> LIB
  S --> LIB
  L --> LIB
  MCP --> LIB
  LIB --> AT & LE & EX & G & I & GN
  AT --> CT & CG
  LE --> CG
```

**Built-in Auto Tasks (13, cron-schedulable on Mac, mirrored on iPhone):**

| Pipeline | Tasks |
|----------|--------|
| Ingest → issues | Source Update · Sources → Issue · Implement Issues · Review & Merge |
| Review | Review Code · Review Doc · Review Conflicts · Regression |
| Generate | Knowledge · Generate Documentation |
| Maintain | Update Issues · Update Plan Status · **Loop** |

**Custom Auto Tasks** — create your own name + prompt; choose **Review** (discard edits) or **Implement** (commit on `fix/custom-*` branch); optional **cron** per task.

**Integrations (opt-in dispatch):** GitHub · GitLab · Backlog · Linear · Slack · **MCP-backed connectors** · **user plugins** (skills, slash commands, subagents).

## Architecture

Four surfaces share one local backend. All traffic stays on `127.0.0.1` unless you set `LLMIDE_ALLOW_REMOTE=1`.

```mermaid
flowchart TB
    subgraph ext [Chrome Extension]
        CC[Caption scraper 800ms]
        SP[Side panel UI]
    end
    subgraph srv [Node Server :3456]
        KB[(SQLite WAL+FTS5<br/>31 migrations)]
        AI[Provider router<br/>CLI or vaulted API keys]
        GR[Guardrails + tool approvals]
    end
    subgraph mac [Mac App]
        AX[AX caption capture]
        MC[MobileControlManager :3006]
        API[LlmIdeAPIClient]
    end
    subgraph ios [iPhone App]
        WS[ConnectionService]
    end
    CC --> srv
    SP --> srv
    AX --> srv
    WS -->|WebSocket + PIN| MC
    MC --> API --> srv
```

| Surface | Role | Default port |
|---------|------|--------------|
| Chrome extension | Meet/Teams/Zoom web CC capture + side panel | talks to `:3456` |
| Node server | Auth, KB, AI orchestration, persistence, connectors | `127.0.0.1:3456` |
| macOS app | Full KB, code assistant, AX capture, mobile server | `:3456` client; `:3006` mobile |
| iPhone app | Companion — chat, explorer, auto-tasks, Loop control | WebSocket to Mac `:3006` |

**AI routing:** `extension/providers/` prefers each user's vaulted API key when present; otherwise shells out to the operator's Claude/Codex/Gemini CLI. See [ADR-0015](docs/decisions/0015-multi-provider-vaulted-api-keys.md).

**Tenancy:** JWT auth, per-user rows, HKDF-derived vault keys. FTS5 is shared; hydration queries are scoped by `user_id`.

Deep dive: [Architecture overview](docs/explanation/architecture.md) · [Server internals](docs/explanation/server-internals.md) · [Engineering invariants](docs/explanation/invariants.md) · [Project folder layout](docs/reference/project-layout.md) · [Naming convention](docs/decisions/0016-naming-convention.md)

### Naming

| Context | Form | Example |
|---------|------|---------|
| User-visible brand | **LLM-IDE** | menus, extension title, docs |
| Repo / package slug | **llm-ide** | `github.com/…/llm-ide`, npm package |
| Code identifiers | **LlmIde** | `LlmIdeMac`, `LlmIdeAPIClient` |
| Wire / bundle | **llmide** | `com.llmide.macapp`, `llmide://` |

## Quick Start (3 Minutes)

```bash
git clone --recurse-submodules git@github.com:dnsmalla/llm-ide.git
cd llm-ide
./setup.sh                        # npm install, .skills submodule, agent symlinks, git hooks
cd extension && npm run build     # extension/dist/ is gitignored — build before loading Chrome
cd extension && npm run server
```

Then load `extension/dist/` as an unpacked Chrome extension. Full tutorial: [Record your first meeting](docs/tutorials/01-first-meeting.md).

> Already cloned without `--recurse-submodules`? Run `./setup.sh` — it initializes `.skills` automatically.

---

## Complete Installation Guide (For Beginners)

### Prerequisites

- **macOS 14+** (for native macOS app; iPhone app needs Xcode + physical device)
- **Node.js 20+** — [Download](https://nodejs.org/)
- **Claude CLI** — [Install guide](https://docs.claude.com/en/docs/claude-code/quickstart) (`claude login`)
- **Git** — pre-installed on macOS
- **Chrome** — for the extension
- **Xcode** (optional) — required for `swift test` / full Mac unit tests; `swift build` works with Command Line Tools

**Check what you have:**

```bash
node --version        # v20+
npm --version         # v10+
claude --version      # should work
git --version
swift --version       # optional, for Mac app
```

### Step 1: Clone the Repository

```bash
git clone --recurse-submodules git@github.com:dnsmalla/llm-ide.git
cd llm-ide
ls -la   # docs/ extension/ mac/ ios_app/ .skills/ setup.sh
```

### Step 2: Run Setup

```bash
./setup.sh
# ✅ Node.js, npm, backend deps (better-sqlite3)
# ✅ Claude CLI
# ✅ .skills submodule + agent symlinks (Claude / Cursor / Codex / …)
# ✅ git hooks (pre-push runs make regression when mac/ changes)
```

If setup fails, see [Troubleshooting](#troubleshooting).

### Step 3: Build the Extension

```bash
cd extension && npm run build
# Writes extension/dist/ — required before loading in Chrome
```

### Step 4: Start the Node Server

```bash
cd extension && npm run server
# Server listening on http://127.0.0.1:3456
```

Keep this terminal running.

### Step 5: Load Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `llm-ide/extension/dist/`
4. Pin the extension icon in the toolbar

### Step 6: Build macOS App

```bash
cd mac && swift build
swift run LlmIdeMac    # or open .build/debug/LlmIdeMac
```

---

## Usage

### Chrome Extension
- Open Google Meet, Microsoft Teams, or Zoom (web)
- Extension captures **live captions** (not microphone audio)
- Side panel: notes, questions, entities, DOCX export

### macOS App
- Native AX caption capture, full Library, Issues, Gantt, Code Assistant
- **Auto Tasks** page: built-in + custom tasks, cron schedules, Loop Engineering
- **Explorer** + codegen workflows with guardrails and tool-approval gates
- **Plugins** — install zip bundles (skills, slash commands, subagents)
- **MCP connectors** — add MCP-backed sources from Library
- **SCIP ingestion** — compiler-derived symbol graph via `POST /kb/ingest-scip`

### iPhone Companion
- Pair via Bonjour or Direct IP + PIN (Mac Settings → Mobile Control)
- Chat, Explorer sessions, Auto Task monitor/run, **Loop** start/stop + live log
- See [Mobile quick start](docs/mobile/quick-start.md)

### Server API
- REST on `http://127.0.0.1:3456` — used by extension, Mac, and mobile proxy
- Wire protocol version tracked in `SERVER_API_VERSION` (`extension/server.mjs`, currently **39**)
- [API Reference](docs/reference/api/overview.md) · [OpenAPI spec](docs/reference/api/openapi.yaml)

---

## After Pulling New Code

```bash
git pull origin main
./setup.sh                    # deps, submodule, skills symlinks
cd extension && npm run build # refresh extension/dist if UI changed
cd extension && npm run server
```

See [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md) for the post-pull checklist.

---

## Development Commands

```bash
# Terminal 1: Node server
cd extension && npm run server

# Terminal 2: Extension dev (hot reload)
cd extension && npm run dev

# Terminal 3: Mac app
cd mac && swift run LlmIdeMac

# Tests
make test                  # extension (Node test runner)
make test-mac              # macOS (requires full Xcode)
make test-shared-protocol  # Mac↔iOS wire types (ios_app/SharedProtocol)
make regression            # pre-push gate (build + tests where available)

# Lint / docs
make lint && make format
make docs-serve            # localhost:8000
make docs-check            # links, frontmatter, API coverage
```

Central agent skills live in the [`.skills`](https://github.com/dnsmalla/skills) submodule. Refresh after pull:

```bash
git submodule update --init --recursive .skills
bash scripts/install-skills.sh
cd extension && npm run sync:skills   # agent tool defs only
```

Agent/developer guide: [CLAUDE.md](CLAUDE.md) · Contributor layout: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Troubleshooting

### ❌ "Cannot find module 'docx'" or other npm errors
```bash
./setup.sh
# or: rm -rf extension/node_modules && npm ci --prefix extension
```

### ❌ "node: command not found"
Install Node.js 20+ from https://nodejs.org/

### ❌ "claude: command not found"
Install and authenticate: https://docs.claude.com/en/docs/claude-code/quickstart → `claude login`

### ❌ "Port 3456 already in use"
```bash
lsof -i :3456 && kill -9 <PID>
cd extension && npm run server
```

### ❌ "Swift build fails"
```bash
xcode-select --install
cd mac && swift build
```

### ❌ "No such module 'XCTest'" when running swift test
Full **Xcode** is required (Command Line Tools alone is not enough). `swift build` still works.

### ❌ Chrome extension not updating
Run `cd extension && npm run build`, refresh on `chrome://extensions`, then hard-reload the meeting tab (Cmd+Shift+R).

### ❌ "Load unpacked" fails — no dist folder
`extension/dist/` is gitignored. Run `cd extension && npm run build` first.

### ❌ Settings/data lost after pull
Your data is safe — only code is pulled:
- Meetings/KB: `kb/` (gitignored per install)
- User settings: `~/.llmide/`

### ❌ GitLab CLI auth from terminal agents
Use `./scripts/gitlab.sh` (reads the same PAT as **Settings → GitLab**). Do not run `glab auth login` separately.

---

## Project Structure

```
llm-ide/
├── extension/          Chrome extension + Node server (:3456)
│   ├── server.mjs      HTTP entry (no framework)
│   ├── core/           Framework-free primitives
│   ├── server/         Routing, JWT, vault, rate limits
│   ├── kb/             SQLite + FTS5 + migrations (0001–0031)
│   ├── routes/         HTTP route modules
│   ├── providers/      Model dispatch (CLI shell-out + vaulted API keys)
│   ├── connectors/     GitHub, GitLab, Slack, Box, email, SCIP, MCP, …
│   ├── agents/         Planner, codegen, dispatch pipelines
│   ├── llm_agent/      Agent runtime + synced tool definitions
│   ├── graphkit/       Code-graph engine + memory writer
│   ├── guardrails/     Secret/PII/destructive-op scanners
│   ├── plugins/        Extension plugin loader/installer
│   ├── llm-sources/    LLM source registry (feeds kb/sources.mjs)
│   ├── mcp/            MCP server config + connector catalog
│   ├── src/            React side panel + content scripts
│   └── dist/           Built extension (load in Chrome; gitignored)
├── mac/                SwiftUI macOS app
│   ├── Sources/LlmIdeMac/
│   └── Tests/
├── ios_app/            iPhone companion (SwiftUI + SharedProtocol)
├── .skills/            Central agent skills submodule
├── scripts/            setup helpers, gitlab.sh, mobile verify, install-skills
├── docs/               MkDocs site (architecture, API, ADRs)
├── kb/                 Runtime SQLite (gitignored content)
├── setup.sh            One-shot install + skills wiring
└── CLAUDE.md           Agent/developer guide
```

Inside each **project**, LLM-IDE scaffolds `source/{meetings,emails,documents}/`, `llm-doc/`, `code/`, `system/`, etc. See [Project folder layout](docs/reference/project-layout.md).

---

## Mobile Control

Native Mac WebSocket server on `:3006` (Bonjour `_llmide._tcp` + PIN pairing). No external Node agent.

| Feature | Description |
|---------|-------------|
| **LLM-IDE Chat** | Ask from iPhone; Mac proxies to `:3456` |
| **Explorer** | List and chat with Mac explorer sessions; attach files from phone |
| **Auto Tasks** | Toggle, run, stop, and inspect scheduled tasks + history |
| **Loop** | Start/stop Loop runs, watch live log, read finished runs (Mac executes) |
| **Pairing** | QR / PIN from Mac Settings → Mobile Control |

📱 [docs/mobile/quick-start.md](docs/mobile/quick-start.md)

**Loopback check:** `swift scripts/mobile/verify-native-pairing.swift`

---

## Documentation

📚 **Full docs site:** https://grid-devs.gitlab.io/personal/dinesh/notes-extension/

| Topic | Link |
|-------|------|
| Architecture | [docs/explanation/architecture.md](docs/explanation/architecture.md) |
| Server internals | [docs/explanation/server-internals.md](docs/explanation/server-internals.md) |
| Invariants (read before changing hot paths) | [docs/explanation/invariants.md](docs/explanation/invariants.md) |
| API overview | [docs/reference/api/overview.md](docs/reference/api/overview.md) |
| Project folder layout | [docs/reference/project-layout.md](docs/reference/project-layout.md) |
| Architecture decisions | [docs/decisions/](docs/decisions/) (ADRs 0001–0016) |
| Central skills install | [docs/how-to/install-central-skills.md](docs/how-to/install-central-skills.md) |
| Contribute | [docs/how-to/contribute.md](docs/how-to/contribute.md) |

---

## Next Steps

1. ✅ Setup done → [Record your first meeting](docs/tutorials/01-first-meeting.md)
2. Configure Auto Tasks → Mac app → **Auto Tasks** (built-in + custom)
3. Pair iPhone → [Mobile quick start](docs/mobile/quick-start.md)
4. Understand the system → [Architecture overview](docs/explanation/architecture.md)

---

## License

MIT.
