---
title: macOS app
status: draft
---

# macOS app

The macOS app is a native SwiftUI client that gives you a first-class desktop experience over the **same local Node server and SQLite database** that the Chrome extension uses. There is no separate backend, no separate database, and no cloud sync — the app simply speaks HTTP to `127.0.0.1:3456` under the same JWT auth scheme.

!!! info "Rebuild-grade detail"
    Exact contracts (service interfaces, server IPC, the platform-coupling table, capture pipeline, build) are in [`../spec/macos-app.md`](../spec/macos-app.md).

## What the app does

The app surfaces five areas that the Chrome extension either cannot do well or cannot do at all in a browser context:

| Area | What it offers |
|---|---|
| **Caption capture** | Reads live captions from Zoom and Microsoft Teams via the macOS Accessibility API — the native analogue of the extension's DOM scraper |
| **Knowledge base** | Full KB search across all meeting kinds (transcripts, actions, decisions, plans, tickets, outcomes) |
| **GitLab Issues** | List view, Kanban, detail panel, create/edit — driven by the GitLab REST API, not via the local server |
| **Gantt chart** | Timeline view with zoom levels and rich filter combinations |
| **Review queue** | Approve or reject pending dispatched actions with a guardrail diff view |

For build instructions, see [How to build the macOS app](../how-to/build-the-macos-app.md).

## Mental model: MVVM + service taxonomy

The source tree under `mac/Sources/LlmIdeMac/` is organised around a strict naming taxonomy:

| Suffix | Role |
|---|---|
| `*Store` | `@Observable` / `@Published` state containers that views bind to directly (e.g. `SessionStore`, `KeychainStore`) |
| `*Service` | Stateless (or lightly stateful) coordinators that own a single responsibility — permissions probing, caption orchestration |
| `*Client` | Network clients — `LlmIdeAPIClient` for the local server, `GitLabClient` for the external API |
| `*Manager` | Lifecycle managers — own a resource whose lifetime they must control (e.g. AX observers) |
| `*Mirror` | Read-only projections of remote or Chrome-extension state into the app (the app mirrors Chrome sessions but does not own them) |
| `*Router` | Navigation coordinators; own the push/pop/sheet stack for a major feature area |

`ViewModels/` holds the heavier per-screen logic (`GanttViewModel`, `ReviewViewModel`) that doesn't fit neatly into a single Store or Service. `Views/` contains pure SwiftUI layout; `Models/` holds plain data types.

## Caption capture: Accessibility-based

The app's capture stance is **Accessibility-tree reading, not screen recording**. The `CaptionScraper` protocol defines a single contract — detect availability, return a snapshot of current caption text — and `CaptionOrchestrator` polls whichever scraper is live at a configurable cadence.

Each platform (Zoom, Teams) has its own implementation that navigates the AX element tree to find the caption overlay and extract its string value. This is the macOS equivalent of the Chrome extension's `caption-scraper.ts`, which walks the browser DOM. Both approaches read the text that the conferencing platform already renders for accessibility; neither does audio transcription.

Because AX access is gated by the OS, the `PermissionsService` probes trust on launch and presents a setup sheet if access is missing. The user must grant access in **System Settings → Privacy & Security → Accessibility** and relaunch — macOS caches AX trust per process.

## What the app sends to the server

The Mac app uses the server as a **read-mostly** client for most routes. The key distinction from the Chrome extension:

- **Capture ingest:** the app calls `POST /kb/ingest` to save a completed meeting session to the knowledge base. This is a batch write on session end.
- **Chrome session mirroring:** the app calls `GET /kb/live/*` routes to *read* in-progress Chrome extension sessions into its `*Mirror` types — it never writes to those routes.
- **All other routes** (`/kb/sessions`, `/kb/library`, `/kb/generate-plan`, `/auth/*`, `/code-assist`, etc.) are standard reads or action-triggered writes, identical to what the extension uses.

See the Wire formats section of [architecture.md](architecture.md) for the full per-client route breakdown.

## Platform coupling at the edges

The app deliberately minimises platform lock-in in its core logic. The porting boundary sits at a thin outer shell:

**macOS-only** (cannot move without rewrite):

- Caption scraping — AX API, `AXUIElement`, `ApplicationServices`
- Credential storage — Keychain (`SecItem*`)
- File dialogs, drag-and-drop — AppKit `NSOpenPanel`
- Global hotkeys — `CGEventTap` / Carbon `EventHotKeyRef`
- Auto-update — Sparkle (macOS DMG workflow)
- Path conventions — `~/Library/Application Support/…`
- Code Assistant composer — `HistoryTextEditor` wraps `NSTextView` to intercept ↑ / ↓ for prompt-history recall (SwiftUI `TextEditor` can't reliably see the arrows once it holds text)

**Portable Swift** (moves to Linux / visionOS with minor changes):

- `LlmIdeAPIClient` — pure `URLSession` async/await
- `GitLabClient` — pure `URLSession`
- All `Models/` data types
- Most `ViewModels/` business logic
- `CaptionScraper` protocol (the implementations are platform-specific; the protocol is not)

This boundary means that logic changes — new KB query shapes, new agent dispatch flows, new GitLab features — rarely touch the macOS-locked layer.

## See also

- [Architecture overview](architecture.md) — how the app fits into the full system
- [Caption capture (explanation)](caption-capture.md) — deeper treatment of the capture stance
- [How to build the macOS app](../how-to/build-the-macos-app.md) — build steps
- [`../spec/macos-app.md`](../spec/macos-app.md) — service interfaces, IPC contracts, platform-coupling table, and capture pipeline in full detail
