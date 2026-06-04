# Mac App Production Hardening Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the LLM IDE macOS app to production quality by fixing security vulnerabilities, eliminating crashes, closing reliability gaps, and cleaning up code quality issues found in the production-readiness audit.

**Architecture:** Three sequential groups — Security & Stability first (prevents data leaks and crashes), then Reliability & UX (closes silent failures and UX gaps visible to users), then Code Quality (internal improvements that prevent future regressions). Each group produces a clean commit.

**Source audit findings:** 3 Critical, 9 High, 13 Medium, 8 Low severity issues across 8 categories.

---

## Group A — Security & Stability

### A1: Move GitLab PAT from UserDefaults to Keychain

**Problem:** `AppConfig` stores `gitLabToken` in `UserDefaults` (`~/Library/Preferences/com.llmide.macapp.plist`) — plaintext, readable by any process with filesystem access.

**Fix:**
- `KeychainStore` already exists at `Services/KeychainStore.swift` for the JWT refresh token. Add two new static methods: `saveGitLabToken(_ token: String, host: String)` and `loadGitLabToken(host: String) -> String?` and `deleteGitLabToken(host: String)`. Use service `com.llmide.macapp`, account key `gitlab::\(host)::token`, accessibility `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
- In `AppConfig`, replace the `gitLabToken` `@Published var` UserDefaults backing with Keychain reads/writes. The getter calls `KeychainStore.loadGitLabToken(host: gitLabBaseURL)`, the setter calls `KeychainStore.saveGitLabToken`.
- **Migration:** In `AppConfig.init()`, after loading, check if `defaults.string(forKey: "gitLabToken")` is non-empty. If so, save it to Keychain and then `defaults.removeObject(forKey: "gitLabToken")`. Run once silently.
- `gitLabBaseURL` and `gitLabSavedProjects` remain in UserDefaults (not sensitive).

**Files:** `Services/KeychainStore.swift`, `Models/Config.swift`

---

### A2: Fix force unwraps in MeetingFileStore

**Problem:** Three locations in `Services/NotesFolder/MeetingFileStore.swift` (lines ~62, ~107, ~140) force-unwrap `.data(using: .utf8)!`. UTF-8 encoding of a Swift String should not fail in practice, but crashes the app if it ever does.

**Fix:** Add a private throwing helper:
```swift
private func utf8Data(_ string: String) throws -> Data {
    guard let data = string.data(using: .utf8) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return data
}
```
Replace all three `body.data(using: .utf8)!` call sites with `try utf8Data(body)`. The `throws` propagates up to the existing `throws` function signatures — no caller changes needed.

**Files:** `Services/NotesFolder/MeetingFileStore.swift`

---

### A3: Cap caption array growth

**Problem:** Both `CaptionOrchestrator` in `Services/CaptionScraper/CaptionScraper.swift` and `LiveSessionMirror` in `Services/LiveSessionMirror.swift` append captions to an unbounded array. An 8-hour recording session accumulates 100MB+ in memory.

**Fix:** Add a constant `private let maxCaptionCount = 10_000`. After each append batch, if `captions.count > maxCaptionCount`, remove the first `min(1_000, captions.count - maxCaptionCount)` elements (drop oldest, keep tail). This preserves the most recent ~40 minutes of captions in memory. The full transcript is persisted to the server on ingest, so nothing is lost.

Apply the same pattern to both files independently.

**Files:** `Services/CaptionScraper/CaptionScraper.swift`, `Services/LiveSessionMirror.swift`

---

## Group B — Reliability & UX

### B1: Replace silent catch blocks with visible error states

**Problem:** Four locations swallow errors silently with empty `catch {}` blocks:
- `Views/AppShell.swift` ~line 203 — recording recovery failure
- `Views/Library/MeetingDetailView.swift` ~line 308 — ViewModel load failure
- `Views/Settings/AgentSettingsSection.swift` ~line 101 — feedback stats load failure
- `Views/Plan/PlanView.swift` ~line 459 — outcomes list load failure

**Fix:** For each location:
- Add `@State private var loadError: String?` if not already present (reuse existing error state where one exists)
- In the catch block: `loadError = error.localizedDescription` (no empty catch)
- Add a small error caption near the relevant UI element:
  ```swift
  if let err = loadError {
      Text(err).font(Typography.caption).foregroundStyle(theme.current.danger)
  }
  ```

No modal alerts. Inline, dismissible by retrying the action.

**Files:** `Views/AppShell.swift`, `Views/Library/MeetingDetailView.swift`, `Views/Settings/AgentSettingsSection.swift`, `Views/Plan/PlanView.swift`

---

### B2: Fix Task cancellation race in PlanView

**Problem:** `Views/Plan/PlanView.swift` has three independent `.task` modifiers that fire concurrently. Rapid tab switching spawns multiple overlapping loads with no cancellation — the last one to finish wins, potentially overwriting newer data with stale results.

**Fix:**
- Remove the three separate `.task` modifiers
- Add `@State private var loadTask: Task<Void, Never>?`
- Replace with a single `.task(id: selectedPlan?.id)` that SwiftUI auto-cancels on id change
- For the tab-appear case, use `.onAppear { loadTask?.cancel(); loadTask = Task { await load() } }`

**Files:** `Views/Plan/PlanView.swift`

---

### B3: Add exponential backoff to TranscriptView polling loop

**Problem:** `Views/TranscriptView.swift` polling loop has no error backoff — on network failure it retries at the full `pollIntervalMs` rate (250ms), generating hundreds of failed requests per minute.

**Fix:**
- Add `@State private var pollBackoffMs: UInt64 = 0`
- On success: `pollBackoffMs = 0`
- On error: `pollBackoffMs = min(pollBackoffMs == 0 ? 2_000 : pollBackoffMs * 2, 60_000)`
- Sleep duration: `max(pollIntervalMs, pollBackoffMs)`
- Reset to `pollIntervalMs` on the next successful response

**Files:** `Views/TranscriptView.swift`

---

### B4: Fix Gantt task name truncation

**Problem:** `Views/Gantt/GanttView.swift` truncates issue titles to a `maxWidth: 80` frame. Most issue titles are invisible.

**Fix:**
- Change the title label frame to `minWidth: 160, maxWidth: 260`
- Add `.help(issue.title)` so hovering shows the full title in a tooltip
- Keep `.lineLimit(1).truncationMode(.tail)` — the tooltip covers readability

**Files:** `Views/Gantt/GanttView.swift`

---

### B5: Fix image overflow in FileDetailView

**Problem:** `Views/Library/FileDetailView.swift` renders images at native pixel size. A 4K image (6000×4000px) overflows the window with no scrolling fallback.

**Fix:** Wrap the image in a `GeometryReader` and apply:
```swift
Image(nsImage: img)
    .resizable()
    .scaledToFit()
    .frame(maxWidth: geo.size.width, maxHeight: geo.size.height)
```

**Files:** `Views/Library/FileDetailView.swift`

---

### B6: HTTPS enforcement warning in Settings

**Problem:** `AppConfig.serverURL` accepts any URL including `http://`. Bearer tokens are sent in plaintext over unencrypted connections when pointing at a non-local server.

**Fix:** In `Views/Settings/ServerSettingsSection.swift` (or wherever the server URL field is rendered), add a computed warning:
```swift
private var isInsecureRemote: Bool {
    let url = config.serverURL.lowercased()
    return url.hasPrefix("http://") && 
           !url.contains("localhost") && 
           !url.contains("127.0.0.1")
}
```
If `isInsecureRemote`, show a yellow warning label below the URL field: *"Unencrypted connection — tokens sent in plaintext."* No blocking.

**Files:** `Views/Settings/ServerSettingsSection.swift`

---

## Group C — Code Quality

### C1: Extract inline HTML from FileDetailView

**Problem:** ~130 lines of HTML/CSS/JavaScript are embedded as a Swift string literal in `Views/Library/FileDetailView.swift` (lines ~94–224). It is un-lintable, hard to read, and any change risks breaking string interpolation.

**Fix:**
- Create `Views/Library/MarkdownRenderer.swift` with a single `enum MarkdownRenderer` containing `static func html(for markdown: String) -> String`
- The HTML template is stored as a `private static let template: String` constant inside the enum, not in an external file (avoids bundle resource complexity)
- `FileDetailView` calls `MarkdownRenderer.html(for: content)` — no behaviour change

**Files:** Create `Views/Library/MarkdownRenderer.swift`, modify `Views/Library/FileDetailView.swift`

---

### C2: Static character set in slugify()

**Problem:** `Services/NotesFolder/MeetingFileStore.slugify()` rebuilds a `CharacterSet` on every call.

**Fix:**
```swift
private static let slugAllowed = CharacterSet.alphanumerics.union(.init(charactersIn: "-_"))
```
Reference `MeetingFileStore.slugAllowed` inside `slugify()` instead of rebuilding.

**Files:** `Services/NotesFolder/MeetingFileStore.swift`

---

### C3: Fix PlanView StateObject lifecycle

**Problem:** `PlanListViewModel` is instantiated inside a `StateObject(wrappedValue:)` expression that may re-execute on parent re-renders, violating SwiftUI's StateObject contract.

**Fix:** Change the declaration to the standard form:
```swift
@StateObject private var vm = PlanListViewModel()
```
SwiftUI guarantees this initializer runs exactly once for the view's lifetime.

**Files:** `Views/Plan/PlanView.swift`

---

### C4: Reorder AnyCodable type probes

**Problem:** `Models/Plan.swift` `AnyCodable` decoder tries 7 types sequentially with `try?` in worst-case order. `String` is the most common value type in plan JSON but is tried last.

**Fix:** Reorder decode attempts: `String` → `Int` → `Bool` → `Double` → `[String: AnyCodable]` → `[AnyCodable]` → `nil`. Most payloads hit on the first or second try instead of the fifth.

**Files:** `Models/Plan.swift`

---

## Out of Scope

The following audit findings are noted but excluded from this plan:
- LlmIdeAPIClient pagination (requires API contract changes)
- LibraryItemStore filesystem enumeration on main thread (requires larger refactor)
- SessionStore refresh slot overflow (theoretical, UInt64 won't overflow in practice)
- Bot error message 140-char truncation (intentional — prevents log injection)

---

## Testing Approach

Each group is verified by:
1. `swift build` with zero warnings or errors
2. `./build_app.sh` producing a signed app
3. Manual smoke test of the affected surface (Settings → GitLab for A1, long recording for A3, Issues/Gantt for B4, FileDetailView for B5)
