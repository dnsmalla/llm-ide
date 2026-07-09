# LLM IDE — macOS App

> Native SwiftUI client for the LLM IDE system. Captures live captions from Zoom and Microsoft Teams, surfaces the full knowledge base, and adds a native GitLab Issues board and Gantt chart — all backed by the same local server as the Chrome extension.

[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-blue.svg)](#requirements)
[![Swift](https://img.shields.io/badge/swift-5.9-orange.svg)](#tech-stack)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](#license)

---

## Features

| Area | Capabilities |
|---|---|
| **Capture** | Live captions from Zoom and Teams via macOS Accessibility API · bilingual transcript rendering |
| **Knowledge Base** | Full KB search across meetings, actions, decisions, plans, code, tickets, and outcomes |
| **Issues** | GitLab Issues board — list view, Kanban, detail panel, create/edit sheet, label / milestone / assignee filters |
| **Gantt** | Timeline chart with Day / Week / Month zoom · state, label, milestone, assignee, and date-range filters |
| **Planning** | Browse saved plans · milestone-grouped task cards with risk coloring |
| **Review** | Approve or reject pending dispatched actions with guardrail diff view |
| **Meeting Agent** | Send the AI agent as co-pilot or in-meeting bot directly from the app |
| **Settings** | GitLab token + project config · server URL · theme · capture preferences |
| **Chat Assistant** | AI-powered code assistant with file attachments, git operations, issue management, PR/MR creation, bash execution, web search, and more |
| **Developer Tools** | Full git workflow integration, issue tracking, code review, file editing, and command execution |

---

## Requirements

| | |
|---|---|
| **OS** | macOS 14 Sonoma or newer |
| **Backend** | LLM IDE server running at `127.0.0.1:3456` (API v15+) |
| **GitLab** | Personal Access Token with `api` scope (for Issues / Gantt) |

---

## Quick Start

### 1 — Start the backend server

```bash
cd /path/to/llm-ide/extension
npm install          # first time only
node server.mjs      # keep this terminal open
```

Verify: `curl http://127.0.0.1:3456/health` should return `status: "ok"`.

### 2 — Build and launch the app

```bash
cd /path/to/llm-ide/mac
./build_app.sh       # compiles, bundles, signs, produces LlmIdeMac.app + DMG
open LlmIdeMac.app
```

### 3 — Grant Accessibility access

The app reads captions from Zoom and Teams via the macOS Accessibility API. On first launch, a Permissions sheet appears:

1. Click **Open System Settings**
2. Go to **Privacy & Security → Accessibility**
3. Toggle **LlmIdeMac** on (authenticate if prompted)
4. **Quit and relaunch** the app — macOS caches AX trust per-process, so the current instance won't see the change until restart

### 4 — Sign in

- **New server:** Register — the first user is automatically promoted to `admin`
- **Existing server:** Sign in with your credentials

The refresh token is stored in the macOS Keychain under `com.llmide.macapp`. Subsequent launches skip the login screen and silently mint a fresh access token.

### 5 — Connect GitLab (optional)

To use the Issues board and Gantt chart:

1. Open **Settings → GitLab**
2. Paste your Personal Access Token (`glpat-…`) and click **Save & verify**
3. Click **Add project**, paste your project URL (e.g. `https://gitlab.com/group/project`), and press **Return**
4. The app resolves the project ID automatically from the URL — no manual configuration needed

---

## Capturing a Meeting

1. Open **Zoom** or **Microsoft Teams** and join a call
2. Enable **Closed Captions** in the meeting controls
   - Zoom: *Show Captions*
   - Teams: *More → Language and speech → Turn on live captions*
3. Click **Start recording** in the app header — the menu-bar icon turns red
4. Captions stream into the **Transcript** tab in real time
5. When the meeting ends, optionally set a title, then click **Stop & Save**
6. The meeting is saved to the KB and immediately available across all clients

---

## Daily Workflows

| Task | How |
|---|---|
| Capture a meeting | Start recording → (Zoom/Teams open with CC on) → Stop & Save |
| Browse issues | **Issues** tab → filter by state / label / milestone / assignee / search |
| View Gantt | **Gantt** tab → zoom Day/Week/Month · filter · hide undated |
| **Use AI chat assistant** | **Chat** tab → attach files · ask questions · run commands |
| **Attach files to chat** | Chat panel → click ➜ · select files · supported formats shown |
| **Run git operations** | Chat → type git command or ask agent · review confirmation sheet |
| **Create issues/PRs** | Chat → ask agent to create issue/PR · review sheet · confirm |
| **Execute bash commands** | Chat → use bash tool · results appear in chat context |
| **Search web** | Chat → web search tool · results cached for session |
| Send AI agent | **Transcript** tab → **Send agent…** → optional meeting URL → Send |
| Read agent reasoning | Click ⓘ on any `[agent ?]` row → reason, confidence, plan task |
| Review pending actions | **Review** tab → read guardrail report → Approve or Reject |
| Search the KB | **History** tab → text search + kind filter |
| Change theme or server | **Settings** tab |

---

## Chat Assistant

The Mac app now includes a full-featured AI code assistant that provides **98-99% feature parity with Claude Code**.

### Core Chat Features

| Feature | Description |
|---|---|
| **File Attachments** | Attach text files, PDFs, and images directly to conversations |
| **Git Integration** | Complete git workflow: clone, branch, commit, push, merge, pull |
| **Issue Management** | Create, update, comment, and list issues on GitLab/GitHub |
| **PR/MR Creation** | Create pull requests and merge requests with file tracking |
| **Code Execution** | Run bash commands and scripts directly from the chat |
| **Web Search** | Enhanced web search with history and result caching |
| **Slash Commands** | Quick access to skills and commands via `/` menu |
| **Agent Modes** | Autonomous agent mode with stop/resume controls |

### File Support

- **Text files**: Source code, markdown, configs, logs
- **Binary files**: PDF documents, images (PNG, JPG, GIF, WebP)
- **Transport**: Binary files encoded as base64 with MIME type tags
- **Display**: Byte sizes for binary files, character counts for text

### Git & Issue Workflow

1. **Branch creation**: Auto-creates branches from agent suggestions
2. **File → PR automation**: Tracks modified files and auto-populates PR descriptions
3. **Multi-platform**: Full GitLab and GitHub support
4. **Confirmation sheets**: Review all git and issue operations before execution

### Code Execution

- **Safety validation**: Blocks dangerous operations (rm -rf, fork bombs, etc.)
- **Output capture**: Returns stdout/stderr with exit codes
- **Working directory**: Supports commands in specific project directories
- **Integration**: Results flow directly into chat context for agent reasoning

### Architecture

The chat assistant is built around a **reactive agent model**:

1. **User Input**: User types messages or attaches files
2. **Tool Recognition**: Agent requests tools (git, issues, file edits, bash, etc.)
3. **Confirmation Flow**: Critical operations show confirmation sheets
4. **Execution**: Operations run locally (git, bash) or via API (GitLab/GitHub)
5. **Response**: Agent sees results and continues conversation

### Extension Architecture

The chat panel is split into focused extensions for maintainability:

- **Core**: `CodeAssistantPanel.swift` - Main state management and UI
- **Sheets**: `CodeAssistant+Sheets.swift` - All sheet content views
- **Issues**: `CodeAssistant+Issues.swift` - Issue workflow and confirmations
- **Attachments**: `CodeAssistant+Attachments.swift` - File handling and display
- **Git**: `CodeAssistant+Git.swift` - Git operations and branch management
- **PR**: `CodeAssistant+PR.swift` - Pull request/merge request creation
- **Bash**: `CodeAssistant+Bash.swift` - Shell command execution

This modular design makes the 3000+ line codebase easy to navigate and extend.

### Safety Features

- **Confirmation sheets**: All write/destructive operations require user approval
- **Command validation**: Bash commands are checked for dangerous patterns
- **Path validation**: File operations only work on explicitly attached files
- **Edit modes**: Auto mode for trusted files, Review mode for full control

---

## Configuration

### User Defaults

| Key | Default | Purpose |
|---|---|---|
| `serverURL` | `http://127.0.0.1:3456` | Backend base URL |
| `themeID` | `dark` | `dark` / `light` / `midnight` |
| `autoCaptureOnMeeting` | `false` | Auto-start recording when Zoom/Teams becomes frontmost |
| `pollIntervalMs` | `250` | AX scraper poll cadence |

All editable from the **Settings** tab.

### Keychain

- **Service:** `com.llmide.macapp`
- **Account:** `<server-host>::refresh_token`
- **Accessibility:** `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — does not sync via iCloud

### Changing the backend URL

1. Settings → Server → enter the new URL → **Save**
2. The app signs you out automatically
3. Sign in against the new server

---

## Project Layout

```
Package.swift
build_app.sh
Sources/LlmIdeMac/
├── LlmIdeMacApp.swift              # @main · environment graph · MenuBarExtra
├── Models/
│   ├── Config.swift                   # UserDefaults-backed prefs + GitLab saved projects
│   ├── Theme.swift                    # dark / light / midnight palettes
│   ├── GitLabModels.swift             # GitLabProject · GitLabIssue · GitLabLabel etc.
│   ├── Caption.swift                  # Caption + MeetingSession
│   └── Plan.swift                     # Plan / PlanTask / PlanSummary
├── Services/
│   ├── GitLabClient.swift             # async/await GitLab REST v4 client
│   ├── GitHubClient.swift             # GitHub REST API client
│   ├── KeychainStore.swift            # per-host JWT storage
│   ├── SessionStore.swift             # @Published session, coalesced refresh
│   ├── PermissionsService.swift       # AX / Screen Recording / Microphone probes
│   ├── ShellState.swift
│   ├── BashService.swift              # Bash/code execution service
│   ├── WebSearchService.swift         # Web search with history and caching
│   ├── API/                           # LlmIdeAPIClient split by domain
│   │   ├── LlmIdeAPIClient+Auth.swift
│   │   ├── LlmIdeAPIClient+Agent.swift
│   │   ├── LlmIdeAPIClient+KB.swift
│   │   ├── LlmIdeAPIClient+CodeAssist.swift
│   │   ├── LlmIdeAPIClient+SourceControl.swift
│   │   └── …
│   └── Repo/                         # Unified GitLab/GitHub backend
│       ├── RepoBackend.swift          # Shared protocol for GitLab/GitHub
│       ├── GitLabClient.swift         # GitLab-specific adapter
│       ├── GitHubClient.swift         # GitHub-specific adapter
│       └── RepoBackendFactory.swift   # Client factory with guardrails
│   └── CaptionScraper/
│       ├── CaptionScraper.swift       # protocol + CaptionOrchestrator
│       ├── ZoomCaptionScraper.swift
│       ├── TeamsCaptionScraper.swift
│       ├── AXCaptionReader.swift
│       └── PlatformDetector.swift
├── ViewModels/
│   ├── GanttViewModel.swift           # issues · filters · layout · date ranges
│   ├── PlanListViewModel.swift
│   └── ReviewViewModel.swift
├── Utilities/
│   ├── ColorPalette.swift             # deterministic per-project colors
│   └── DateFormatters.swift
└── Views/
    ├── AppShell.swift                 # root navigation + sidebar
    ├── LoginView.swift
    ├── SettingsView.swift
    ├── TranscriptView.swift
    ├── ReviewView.swift
    ├── CodeAssistantPanel.swift      # AI chat assistant (main panel)
    ├── CodeAssistant+Sheets.swift     # Chat sheet content views
    ├── CodeAssistant+Issues.swift    # Issue routing and confirmation
    ├── CodeAssistant+Attachments.swift # File attachment handling
    ├── CodeAssistant+Git.swift       # Git operations
    ├── CodeAssistant+PR.swift        # PR/MR creation
    ├── CodeAssistant+Bash.swift     # Bash/code execution
    ├── Library/                       # meeting list, detail, summary sections
    ├── Issues/
    │   ├── IssueBoardView.swift       # project picker · list · filter bar
    │   ├── IssueDetailPanel.swift     # full issue detail + comments
    │   ├── IssueCreateSheet.swift     # create / edit sheet
    │   └── IssueKanbanPanel.swift     # kanban column view
    ├── Gantt/
    │   ├── GanttContainerView.swift   # project picker + load coordinator
    │   ├── GanttView.swift            # timeline canvas + header bar + legend
    │   └── GanttFilterBar.swift       # search · state · milestone · assignee · label · date
    ├── Settings/
    │   ├── GitLabSettingsSection.swift
    │   ├── GitHubSettingsSection.swift
    │   ├── AppearanceSettingsSection.swift
    │   └── …
    ├── Shell/
    │   └── SidebarView.swift
    ├── Components/
    │   ├── PRCreationSheet.swift      # PR/MR creation sheet
    │   ├── BranchCreationSheet.swift   # Branch creation sheet
    │   ├── GitOpSheet.swift           # Git operation confirmation
    │   ├── UpdateFileSheet.swift      # File edit confirmation
    │   ├── AttachmentChip.swift       # File attachment chip
    │   ├── WebSearchHistoryView.swift # Web search history UI
    │   ├── EmptyStateView.swift
    │   ├── LabelChip.swift
    │   ├── UserAvatar.swift
    │   └── SectionLabel.swift
    └── Shared/
```

---

## Adding a Caption Scraper for a New Platform

The orchestrator selects the first available scraper, so supporting a new platform (Webex, FaceTime, Discord) is a single-file addition:

1. Create `Services/CaptionScraper/<Platform>CaptionScraper.swift` conforming to the `CaptionScraper` protocol — implement `isAvailable()` and `snapshot()`
2. Append it to `PlatformDetector.allScrapers`

The orchestrator's `tick()` picks it up automatically on the next recording start.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App won't launch ("untrusted developer") | Ad-hoc signature + Gatekeeper | Right-click → Open → Open anyway |
| *Network error* on sign-in | Backend not running or wrong URL | `curl <serverURL>/health`; check Settings → Server |
| *401 invalid credentials* | Wrong password or wrong server | Confirm the server URL in Settings matches your account |
| Recording starts, transcript stays empty | Accessibility not granted | System Settings → Privacy & Security → Accessibility → toggle off/on; **quit + relaunch** |
| Issues or Gantt loads all projects | Saved project has no resolved ID | Open Settings → GitLab, paste the project URL, press **Return** to resolve |
| Plan tab empty after saving a meeting | Plans are not auto-generated | Use the Chrome extension's Plan tab or `POST /kb/generate-plan` |
| 429 rate limited | Per-user LLM rate buckets | Wait the `Retry-After` duration |
| Captions stop after a Zoom/Teams update | UI redesign broke AX selectors | Check `ZoomCaptionScraper.swift` or `TeamsCaptionScraper.swift` |

**Debug logs**

```bash
# Server
LLMIDE_LOG_LEVEL=debug node server.mjs
```

Open **Console.app** and filter on subsystem `com.llmide.macapp` for capture, session, and API logs from the app.

---

## Distribution

The default `build_app.sh` produces an **ad-hoc signed** build, which Gatekeeper will warn about on other machines. To distribute:

1. Obtain a **Developer ID Application** certificate from the Apple developer portal
2. In `build_app.sh`, replace `codesign -s -` with:
   ```bash
   codesign -s "Developer ID Application: <Name> (<TEAMID>)" \
     --options runtime --timestamp --force --deep
   ```
3. **Notarize:**
   ```bash
   xcrun notarytool submit LlmIdeMac_v0.1.0.dmg \
     --keychain-profile "AC_PASSWORD" --wait
   xcrun stapler staple LlmIdeMac.app
   ```
4. **Auto-update:** wire [Sparkle](https://sparkle-project.org/) — the DMG is already UDZO format and Sparkle-compatible
5. **Skip the Mac App Store** — Accessibility-based caption scraping conflicts with MAS sandbox requirements

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | Swift 5.9 · SwiftUI · Combine |
| System | AppKit · AVFoundation · ApplicationServices · ScreenCaptureKit |
| Capture | macOS Accessibility API · AXUIElement scraping |
| Networking | URLSession · async/await · concurrent page fetching |
| Auth | JWT in memory · refresh token in macOS Keychain |
| GitLab | REST API v4 · parallel issue pagination |
| GitHub | REST API v3 · issue/PR/comment operations |
| Chat | AI assistant · file attachments · bash execution · web search |
| Process | Swift Process() for shell command execution |
| File I/O | FileManager · atomically-safe writes · path canonicalization |

---

## Documentation

Full engineering docs: <SITE_URL>. See also [How to build the macOS app](../docs/how-to/build-the-macos-app.md).

---

## License

MIT
