# Meet Notes — macOS App

> Native SwiftUI client for the Meet Notes system. Captures live captions from Zoom and Microsoft Teams, surfaces the full knowledge base, and adds a native GitLab Issues board and Gantt chart — all backed by the same local server as the Chrome extension.

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

---

## Requirements

| | |
|---|---|
| **OS** | macOS 14 Sonoma or newer |
| **Backend** | Meet Notes server running at `127.0.0.1:3456` (API v15+) |
| **GitLab** | Personal Access Token with `api` scope (for Issues / Gantt) |

---

## Quick Start

### 1 — Start the backend server

```bash
cd /path/to/meet-notes/extension
npm install          # first time only
node server.mjs      # keep this terminal open
```

Verify: `curl http://127.0.0.1:3456/health` should return `status: "ok"`.

### 2 — Build and launch the app

```bash
cd /path/to/meet-notes/mac
./build_app.sh       # compiles, bundles, signs, produces MeetNotesMac.app + DMG
open MeetNotesMac.app
```

### 3 — Grant Accessibility access

The app reads captions from Zoom and Teams via the macOS Accessibility API. On first launch, a Permissions sheet appears:

1. Click **Open System Settings**
2. Go to **Privacy & Security → Accessibility**
3. Toggle **MeetNotesMac** on (authenticate if prompted)
4. **Quit and relaunch** the app — macOS caches AX trust per-process, so the current instance won't see the change until restart

### 4 — Sign in

- **New server:** Register — the first user is automatically promoted to `admin`
- **Existing server:** Sign in with your credentials

The refresh token is stored in the macOS Keychain under `com.meetnotes.macapp`. Subsequent launches skip the login screen and silently mint a fresh access token.

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
| Send AI agent | **Transcript** tab → **Send agent…** → optional meeting URL → Send |
| Read agent reasoning | Click ⓘ on any `[agent ?]` row → reason, confidence, plan task |
| Review pending actions | **Review** tab → read guardrail report → Approve or Reject |
| Search the KB | **History** tab → text search + kind filter |
| Change theme or server | **Settings** tab |

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

- **Service:** `com.meetnotes.macapp`
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
Sources/MeetNotesMac/
├── MeetNotesMacApp.swift              # @main · environment graph · MenuBarExtra
├── Models/
│   ├── Config.swift                   # UserDefaults-backed prefs + GitLab saved projects
│   ├── Theme.swift                    # dark / light / midnight palettes
│   ├── GitLabModels.swift             # GitLabProject · GitLabIssue · GitLabLabel etc.
│   ├── Caption.swift                  # Caption + MeetingSession
│   └── Plan.swift                     # Plan / PlanTask / PlanSummary
├── Services/
│   ├── GitLabClient.swift             # async/await GitLab REST v4 client
│   ├── KeychainStore.swift            # per-host JWT storage
│   ├── SessionStore.swift             # @Published session, coalesced refresh
│   ├── PermissionsService.swift       # AX / Screen Recording / Microphone probes
│   ├── ShellState.swift
│   ├── API/                           # MeetNotesAPIClient split by domain
│   │   ├── MeetNotesAPIClient+Auth.swift
│   │   ├── MeetNotesAPIClient+Agent.swift
│   │   ├── MeetNotesAPIClient+KB.swift
│   │   └── …
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
    │   ├── AppearanceSettingsSection.swift
    │   └── …
    ├── Shell/
    │   └── SidebarView.swift
    ├── Shared/
    └── Components/
        ├── EmptyStateView.swift
        ├── AttachmentChip.swift
        ├── LabelChip.swift
        ├── UserAvatar.swift
        └── SectionLabel.swift
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
MEETNOTES_LOG_LEVEL=debug node server.mjs
```

Open **Console.app** and filter on subsystem `com.meetnotes.macapp` for capture, session, and API logs from the app.

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
   xcrun notarytool submit MeetNotesMac_v0.1.0.dmg \
     --keychain-profile "AC_PASSWORD" --wait
   xcrun stapler staple MeetNotesMac.app
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

---

## Documentation

Full engineering docs: <SITE_URL>. See also [How to build the macOS app](../docs/how-to/build-the-macos-app.md).

---

## License

MIT
