# LLM-IDE — macOS App

> Native SwiftUI client for the LLM-IDE system. Captures live captions from Zoom and Microsoft Teams, surfaces the full knowledge base, and adds a native GitLab Issues board and Gantt chart — all backed by the same local server as the Chrome extension.

[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-blue.svg)](#requirements)
[![Swift](https://img.shields.io/badge/swift-5.9-orange.svg)](#tech-stack)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](#license)

***

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

***

## Requirements

| | |
|---|---|
| **OS** | macOS 14 Sonoma or newer |
| **Backend** | LLM-IDE server running at `127.0.0.1:3456` (API **v20+**; check Settings → Backend if features 404) |
| **GitLab** | Personal Access Token with `api` scope (for Issues / Gantt) |

***

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

***

## Capturing a Meeting

**Native capture (this app):** Zoom and Microsoft Teams **desktop** apps via the Accessibility API. For **Google Meet**, **Teams web**, or **Zoom web**, use the [Chrome extension](../extension/) — the Mac app’s **Live** tab mirrors extension sessions in real time.

1. Open **Zoom** or **Microsoft Teams** (desktop) and join a call
2. Enable **Closed Captions** in the meeting controls
   - Zoom: *Show Captions*
   - Teams: *More → Language and speech → Turn on live captions*
3. Click **Start recording** in the app header — the menu-bar icon turns red
4. Captions appear in the **Transcript** tab as they are read from the meeting app (local preview; not streamed to the server during the call)
5. When the meeting ends, optionally set a title, then click **Stop & Save**
6. The transcript is POSTed to **`POST /kb/ingest`** and becomes available across all clients

***

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

***

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

***

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

### Optional components

Large runtime pieces the app does not ship and downloads only when you ask.
Manage them in **Settings → Optional components**.

| Component | Size | Needed for | Stored at |
|---|---|---|---|
| mermaid 11.17.2 | 3.4 MB | Drawing ```` ```mermaid ```` blocks as diagrams in markdown previews (Library/Explorer/Search, plan editor, Doc Gen) | `~/Library/Application Support/llm-ide/runtime/mermaid/11.17.2/mermaid.min.js` |

- Nothing downloads on its own. A preview whose document has a mermaid block
  shows an **Install** banner; until you click it the block renders as code.
- The file comes from `https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js`
  and is used only if its SHA-256 matches the hash pinned in
  `Sources/LlmIdeMac/Core/Editor/Mermaid.swift` — also re-checked every time
  the app loads it from disk.
- **Remove** in Settings deletes the folder; previews fall back to code blocks.
- To bump the pin: `npm install mermaid@<version> --no-save && node Scripts/mermaid-pin.mjs <version>`
  (confirms the CDN file equals the npm tarball, then prints the constants).

### Changing the backend URL

1. Settings → Server → enter the new URL → **Save**
2. The app signs you out automatically
3. Sign in against the new server

***

## Project Layout

The app target is organised **Shell → Features → Core**: a feature may use `Core`, never another feature and never `Shell`. That layering is what lets a build drop whole feature folders (see [Feature builds](#feature-builds)). The authoritative folder → layer map is [`Scripts/feature-map.txt`](Scripts/feature-map.txt), checked by `Scripts/feature-boundaries.sh`.

```text
Package.swift                 # targets + LLMIDE_FEATURES build-time exclusion
build_app.sh
Sources/LlmIdeMac/
├── Shell/                    # composition root: LlmIdeMacApp (@main), AppShell, ContentView,
│   │                         #   FeatureCatalog, DeepLinkRouter, LoginView, ReconnectView,
│   │                         #   Recovery/, Welcome/, ChatScope+Shell (scope → sidebar section)
│   └── Chrome/               # StatusBar, ActivityBell, toolbar, banners
├── Features/                 # one folder per section; never references another feature
│   ├── Chat/                 # Code Assistant + quick chat (Models/ Engine/ Session/
│   │                         #   Transport/ (CodeAssistTransport) Services/ Views/{Panel,Quick,Shared})
│   ├── Library/ · Live/ · Settings/ · ReviewConflicts/        # always compiled
│   ├── Explorer/ · Search/ · SourceControl/                   # file_explorer
│   ├── CodeGraph/                                             # code_graph_3d
│   ├── Issues/ · Gantt/                                       # gantt_issues
│   ├── DocGen/ · Visual/ · Generation/                        # doc_gen
│   ├── Terminal/                                              # terminal
│   ├── AutoTask/ · Loop/                                      # auto_tasks
│   └── MobileControl/                                         # mobile_sync
├── Core/                     # leaf infrastructure, never excluded, usable by any layer
│   ├── Contracts/            # cross-feature protocols (LoopRunning, MobileFeatureBridge,
│   │                         #   MobileChatHosting (Mobile Control's view of Chat: phone
│   │                         #   chat turns, Explorer sessions, approvals; Chat implements,
│   │                         #   Shell installs in bootMobile),
│   │                         #   ChatTransport engine↔transport contract, ChatScope,
│   │                         #   ShellSection + LibrarySelection, SettingsSectionRegistry
│   │                         #   (features' Settings cards, registered by Shell),
│   │                         #   ChatPanelProviding (ChatPanelRegistry: chat panel + code-change
│   │                         #   sheets features embed, installed by Shell), ChatOutputProviding,
│   │                         #   LiveCaptureProviding (LiveCaptureGate: Live's recording take-over
│   │                         #   of Library's meeting detail, installed by Shell),
│   │                         #   EditAcceptanceMode, SourceIngesting (Library ingestion for
│   │                         #   AutoTask), LoopSweepPlanning (Loop's loop selection for
│   │                         #   AutoTask's sweep), IssueSeams (Issues' existing-issue picker
│   │                         #   + recent issues), ProjectMemoryProviding (Explorer's memory
│   │                         #   viewer), TerminalPanelProviding (the Terminal dock) — the
│   │                         #   last three installed by Shell's installFeatureSeams, …)
│   ├── DesignSystem/         # shared SwiftUI chrome + Components/, LibraryPicker, section chrome
│   │                         #   features render (SectionChromeBar, PanelSectionTabs, WindowHeightKey)
│   ├── Editor/               # completion menu + ChatSlashCommands ("/" catalog), hunk staging,
│   │                         #   Mermaid/MermaidRuntime (on-demand diagram component)
│   ├── FeatureToggles/       # feature runtime: AppFeature, ProfilePreset, FeatureRegistry,
│   │                         #   AppModule/FeatureService (Shell's FeatureCatalog fills it at boot)
│   ├── Generation/ · Incidents/ · Memory/ · Verification/
│   ├── Networking/           # LlmIdeAPIClient + API/ extensions, BackendManager
│   ├── Notes/                # on-disk notes store: LibraryItemStore, NoteService, MeetingIndex,
│   │                         #   FolderIndexer, IngestTemplateRenderer, launch folder migrations,
│   │                         #   meeting files + summarization shared by Live and Library
│   │                         #   (MeetingFileStore, PartialRecovery, MeetingSummarizationService,
│   │                         #   MeetingNoteWriter/Generator, IngestNoteDedup), …
│   ├── Platform/             # AppDelegate + AppTerminationHooks, FeatureCacheHooks, Config, Theme,
│   │                         #   KeychainStore, SessionStore, ShellState, TerminalPanelState, utilities
│   ├── Project/              # Project/Plan models, WorkspaceRoot, ProjectStore, scaffolding,
│   │                         #   ProjectExporter (KB → project folder export),
│   │                         #   ActiveProjectResolver (agent's active project)
│   └── Repo/                 # GitLab/GitHub clients behind RepoBackend (Services/Repo/),
│                             #   CodeWorkflowTarget (Models/: code-change sheets' repo target)
└── ClaudeLink/               # Claude SDK/CLI glue (counted as Core)
```

The full annotated tree is in the repository root [`CLAUDE.md`](../CLAUDE.md) under "Project Structure".

***

## Feature builds

Small and fast is a product goal: a build can leave features out of the compiled binary instead of only hiding them. `Package.swift` reads `LLMIDE_FEATURES`, a comma-separated list of the features to **include** (unset = all), and excludes every other feature's source folders and tests.

| Key | Excludes |
|---|---|
| `code_graph_3d` | `Features/CodeGraph` (and the GraphCore/GraphKit products) |
| `file_explorer` | `Features/Explorer`, `Features/Search`, `Features/SourceControl` |
| `gantt_issues` | `Features/Issues` (Gantt lives in `Issues/Gantt/`) |
| `doc_gen` | `Features/Generation` (Doc Gen and Visual live in `Generation/DocGen/`, `Generation/Visual/`) |
| `terminal` | `Features/Terminal` (and the SwiftTerm product) |
| `auto_tasks` | `Features/AutoTask`, `Features/Loop` |
| `mobile_sync` | `Features/MobileControl` (and the SharedProtocol product) |

`agent_chat` is never excludable; Chat, Library, Live, Settings and ReviewConflicts are compiled into every build. `code_graph_3d`, `gantt_issues` and `doc_gen` depend on `file_explorer`, and `Package.swift` applies that closure itself: a list without `file_explorer` drops those three as well.

```bash
make build-mac-lite          # agent_chat,auto_tasks,mobile_sync
make build-mac-min           # agent_chat only — all 7 excludable features removed
make build-mac-mobile-only   # agent_chat,mobile_sync — guards the mobile/auto-tasks bridge seam
```

The targets pass `--manifest-cache none` (SwiftPM does not key its manifest cache on environment variables) and use their own `--scratch-path`. On a source checkout, Settings → Workspace → **Apply & Rebuild (remove disabled code)** does the same from inside the app: it stages a release build with only the enabled features and swaps it in on restart. The full contract is in [`docs/spec/macos-app.md`](../docs/spec/macos-app.md) ("Build-time feature selection" and "Apply & Rebuild").

***

## Adding a Caption Scraper for a New Platform

The orchestrator selects the first available scraper, so supporting a new platform (Webex, FaceTime, Discord) is a single-file addition:

1. Create `Sources/LlmIdeMac/Features/Live/Services/<Platform>CaptionScraper.swift` conforming to the `CaptionScraper` protocol — implement `isAvailable()` and `snapshot()`
2. Append it to `PlatformDetector.allScrapers`

The orchestrator's `tick()` picks it up automatically on the next recording start.

***

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

***

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

### Stripped executable and debug symbols

`Scripts/build.sh` (and so `build_app.sh`, `Scripts/release.sh` and Apply & Rebuild) strips the app's own executable with `strip -S -x` before signing. About 60% of a release binary is Swift's local symbol names, which nothing reads at runtime. Sparkle's pre-built helpers are left as they are.

The debug symbols are first written with `dsymutil` to a dSYM **beside** the bundle, never inside it:

| Build | dSYM |
|---|---|
| `build_app.sh`, `Scripts/build.sh`, `Scripts/release.sh` | `mac/LlmIdeMac.app.dSYM` |
| `LLMIDE_APP_DIR=<dir>/X.app` | `<dir>/X.app.dSYM` |
| Apply & Rebuild | `~/Library/Application Support/llm-ide/rebuild-staging/LlmIdeMac.app.dSYM` (the swap installs only the `.app`; the next rebuild replaces it) |

Keep the dSYM of every build you hand out: it is the only way to put names on that build's crash frames. macOS writes its crash reports to `~/Library/Logs/DiagnosticReports/*.ips`, which list each image's UUID and load address. To symbolicate a frame:

```bash
dwarfdump --uuid LlmIdeMac.app.dSYM    # must match the crash report's LlmIdeMac UUID
atos -arch arm64 -o LlmIdeMac.app.dSYM/Contents/Resources/DWARF/LlmIdeMac \
  -l <LlmIdeMac load address> <frame address>
```

The app's own crash banner logs (`Application Support/llm-ide/crashes/`) name only exported symbols for the app's frames once it is stripped. An uncaught-exception log therefore ends with a binary-image block (written by `CrashBinaryImage` in `Shell/CrashBinaryImage.swift`): the image path, arch, `uuid` (compare with `dwarfdump --uuid`) and `load address` — the `-l` value for the `atos` command above, with the stack's addresses as the frame addresses. Signal logs carry no stack, so they get no block.

To debug a release build with the full symbol table left in the executable, run `LLMIDE_SKIP_STRIP=1 ./build_app.sh`. The dSYM is written either way. If `dsymutil` fails, `build.sh` warns and leaves the executable unstripped, because a binary whose symbols are saved nowhere cannot be symbolicated.

***

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

***

## Documentation

Full engineering docs: <SITE_URL>. See also [How to build the macOS app](../docs/how-to/build-the-macos-app.md).

***

## License

MIT
