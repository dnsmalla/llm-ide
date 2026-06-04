# Mac App Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the LLM IDE macOS app to production quality by fixing security vulnerabilities, eliminating crashes, closing reliability gaps, and cleaning up code quality issues.

**Architecture:** Three sequential groups — Security & Stability (Group A), Reliability & UX (Group B), Code Quality (Group C). Each group ends with `swift build` + one commit. Groups must be done in order because A1 affects Config.swift which B1 also touches.

**Tech Stack:** Swift 5.9 · SwiftUI · Security framework (Keychain) · Combine

---

## File Map

| File | Action |
|---|---|
| `Services/KeychainStore.swift` | **Create** — new file with GitLab token Keychain methods |
| `Models/Config.swift` | **Modify** — replace UserDefaults gitLabToken with Keychain + migration |
| `Services/NotesFolder/MeetingFileStore.swift` | **Modify** — replace force unwraps + static CharacterSet |
| `Services/CaptionScraper/CaptionScraper.swift` | **Modify** — cap captions array |
| `Services/LiveSessionMirror.swift` | **Modify** — cap captions array |
| `Views/AppShell.swift` | **Modify** — surface catch error |
| `Views/Library/MeetingDetailView.swift` | **Modify** — surface catch error |
| `Views/Settings/AgentSettingsSection.swift` | **Modify** — surface catch error |
| `Views/Settings/ServerSettingsSection.swift` | **Modify** — add HTTPS warning |
| `Views/TranscriptView.swift` | **Modify** — exponential backoff on polling loop |
| `Views/PlanView.swift` | **Modify** — fix StateObject + task cancellation |
| `Views/Gantt/GanttView.swift` | **Modify** — fix milestone title truncation |
| `Views/Library/FileDetailView.swift` | **Modify** — fix image overflow with GeometryReader |
| `Views/Library/MarkdownRenderer.swift` | **Create** — extract inline HTML template |
| `Models/Plan.swift` | **Modify** — reorder AnyCodable decode probes |

---

## Group A — Security & Stability

### Task A1: Move GitLab PAT from UserDefaults to Keychain

**Files:**
- Create: `Sources/LlmIdeMac/Services/KeychainStore.swift`
- Modify: `Sources/LlmIdeMac/Models/Config.swift`

- [ ] **Step 1: Create KeychainStore.swift with GitLab token methods**

Create `Sources/LlmIdeMac/Services/KeychainStore.swift`:

```swift
import Foundation
import Security

enum KeychainStore {
    private static let service = "com.llmide.macapp"

    // MARK: - JWT refresh token (existing pattern, kept for reference)

    static func saveToken(_ token: String, host: String) {
        let account = "\(host)::refresh_token"
        save(token, account: account)
    }

    static func loadToken(host: String) -> String? {
        load(account: "\(host)::refresh_token")
    }

    static func deleteToken(host: String) {
        delete(account: "\(host)::refresh_token")
    }

    // MARK: - GitLab PAT

    static func saveGitLabToken(_ token: String, host: String) {
        save(token, account: "gitlab::\(host)::token")
    }

    static func loadGitLabToken(host: String) -> String? {
        load(account: "gitlab::\(host)::token")
    }

    static func deleteGitLabToken(host: String) {
        delete(account: "gitlab::\(host)::token")
    }

    // MARK: - Primitives

    private static func save(_ value: String, account: String) {
        guard let data = value.data(using: .utf8) else { return }
        delete(account: account)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData: data
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    private static func load(account: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(account: String) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
```

- [ ] **Step 2: Update AppConfig to use Keychain for gitLabToken**

In `Sources/LlmIdeMac/Models/Config.swift`, replace lines 61–64 (the `gitLabToken` published property and its `didSet`):

Old code (lines 61–64):
```swift
    // ── GitLab integration ────────────────────────────────────────────
    /// Personal Access Token with api scope. Stored locally only.
    @Published var gitLabToken: String {
        didSet { defaults.set(gitLabToken, forKey: "gitLabToken") }
    }
```

New code:
```swift
    // ── GitLab integration ────────────────────────────────────────────
    /// Personal Access Token with api scope. Stored in Keychain.
    @Published var gitLabToken: String {
        didSet {
            KeychainStore.saveGitLabToken(gitLabToken, host: gitLabBaseURL)
        }
    }
```

- [ ] **Step 3: Update AppConfig.init() to load token from Keychain + migrate**

In `Sources/LlmIdeMac/Models/Config.swift`, replace the init line that sets `gitLabToken` (line 95):

Old code:
```swift
        self.gitLabToken = defaults.string(forKey: "gitLabToken") ?? ""
```

New code:
```swift
        // Load from Keychain; fall back to UserDefaults for one-time migration.
        let baseURLForInit = defaults.string(forKey: "gitLabBaseURL") ?? "https://gitlab.com"
        if let migrated = defaults.string(forKey: "gitLabToken"), !migrated.isEmpty {
            KeychainStore.saveGitLabToken(migrated, host: baseURLForInit)
            defaults.removeObject(forKey: "gitLabToken")
            self.gitLabToken = migrated
        } else {
            self.gitLabToken = KeychainStore.loadGitLabToken(host: baseURLForInit) ?? ""
        }
```

- [ ] **Step 4: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|warning:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task A2: Fix force unwraps in MeetingFileStore

**Files:**
- Modify: `Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift`

- [ ] **Step 1: Add utf8Data helper and replace force unwraps**

In `Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift`, add a private helper after the `renderSummarySection` method (after line 208, before the closing `}`):

```swift
    private func utf8Data(_ string: String) throws -> Data {
        guard let data = string.data(using: .utf8) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return data
    }
```

- [ ] **Step 2: Fix line 62 — createPartial**

In `createPartial`, replace:
```swift
        try body.data(using: .utf8)!.write(to: url, options: .atomic)
```
With:
```swift
        try utf8Data(body).write(to: url, options: .atomic)
```

- [ ] **Step 3: Fix line 107 — finalize (handle variant)**

In `finalize(handle:title:endedAt:participants:)`, replace:
```swift
        try rewritten.data(using: .utf8)!.write(to: handle.url, options: .atomic)
```
With:
```swift
        try utf8Data(rewritten).write(to: handle.url, options: .atomic)
```

- [ ] **Step 4: Fix line 140 — writeSummary**

In `writeSummary`, replace:
```swift
        try final.data(using: .utf8)!.write(to: url, options: .atomic)
```
With:
```swift
        try utf8Data(final).write(to: url, options: .atomic)
```

- [ ] **Step 5: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task A3: Cap caption array growth

**Files:**
- Modify: `Sources/LlmIdeMac/Services/CaptionScraper/CaptionScraper.swift`
- Modify: `Sources/LlmIdeMac/Services/LiveSessionMirror.swift`

- [ ] **Step 1: Add cap constant and trim logic to CaptionOrchestrator**

In `Sources/LlmIdeMac/Services/CaptionScraper/CaptionScraper.swift`, add a constant after the `private let pollInterval: TimeInterval` declaration (after line 76):

```swift
    private let maxCaptionCount = 10_000
```

In the `tick()` method, after the `captions.append(Caption(...))` call at line 264, add the trim:

Old code in `tick()`:
```swift
        for (speaker, text) in scraper.snapshot() {
            let key = "\(speaker)::\(text)"
            if recentKeys.contains(where: { $0.key == key }) { continue }
            recentKeys.append((key, now))
            captions.append(Caption(speaker: speaker, text: text, source: scraper.source))
            if let h = fileHandle {
                try? h.appendCaption(timestamp: now, speaker: speaker, text: text)
            }
        }
```

New code:
```swift
        for (speaker, text) in scraper.snapshot() {
            let key = "\(speaker)::\(text)"
            if recentKeys.contains(where: { $0.key == key }) { continue }
            recentKeys.append((key, now))
            captions.append(Caption(speaker: speaker, text: text, source: scraper.source))
            if let h = fileHandle {
                try? h.appendCaption(timestamp: now, speaker: speaker, text: text)
            }
        }
        if captions.count > maxCaptionCount {
            captions.removeFirst(min(1_000, captions.count - maxCaptionCount))
        }
```

- [ ] **Step 2: Add cap constant and trim logic to LiveSessionMirror**

In `Sources/LlmIdeMac/Services/LiveSessionMirror.swift`, add a constant after the `private let finalizedSlowdownNs` declaration (after line 44):

```swift
    private let maxCaptionCount = 10_000
```

In the `pollOnce()` method, after the `captions.append(contentsOf: mapped)` call at line 135, add the trim:

Old code:
```swift
                captions.append(contentsOf: mapped)
                sinceSeq = r.sequence
```

New code:
```swift
                captions.append(contentsOf: mapped)
                sinceSeq = r.sequence
                if captions.count > maxCaptionCount {
                    captions.removeFirst(min(1_000, captions.count - maxCaptionCount))
                }
```

- [ ] **Step 3: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

- [ ] **Step 4: Commit Group A**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
git add Sources/LlmIdeMac/Services/KeychainStore.swift \
        Sources/LlmIdeMac/Models/Config.swift \
        Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift \
        Sources/LlmIdeMac/Services/CaptionScraper/CaptionScraper.swift \
        Sources/LlmIdeMac/Services/LiveSessionMirror.swift
git commit -m "security: move GitLab PAT to Keychain, fix force unwraps, cap caption arrays"
```

---

## Group B — Reliability & UX

### Task B1: Replace silent catch blocks with visible error states

**Files:**
- Modify: `Sources/LlmIdeMac/Views/AppShell.swift`
- Modify: `Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift`
- Modify: `Sources/LlmIdeMac/Views/Settings/AgentSettingsSection.swift`

**Note:** PlanView's outcomes error is already surfaced via `outcomesError` state; only the three above have empty catches.

- [ ] **Step 1: Fix AppShell.swift line 203**

In `Sources/LlmIdeMac/Views/AppShell.swift`, locate the recovery task around line 195–204:

```swift
            } catch {}
```

Replace the empty catch with:
```swift
            } catch {
                await MainActor.run {
                    recoverError = error.localizedDescription
                }
            }
```

Then add `@State private var recoverError: String?` to the view's state declarations (near the top of the struct). Also add an error display in the appropriate place in `body`. Find a good location — typically near where recovery is triggered — and add:

```swift
if let err = recoverError {
    Text(err)
        .font(Typography.caption)
        .foregroundStyle(theme.current.danger)
        .padding(.horizontal)
}
```

- [ ] **Step 2: Fix MeetingDetailView.swift line 308**

In `Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift`, locate the `reload(for:)` function:

Old code (line 308):
```swift
        do { try await newVM.load() } catch {}
```

New code:
```swift
        do {
            try await newVM.load()
        } catch {
            vm = nil
            isLoadingVM = false
        }
```

Add `@State private var loadError: String?` to the struct's state declarations. Replace `vm = nil; isLoadingVM = false` inside catch with:

```swift
        } catch {
            loadError = error.localizedDescription
            isLoadingVM = false
        }
```

Then in the view body, add an inline error display. Find the detail content area and add:
```swift
if let err = loadError {
    Text(err)
        .font(Typography.caption)
        .foregroundStyle(theme.current.danger)
        .padding()
}
```

- [ ] **Step 3: Fix AgentSettingsSection.swift lines 96–103**

In `Sources/LlmIdeMac/Views/Settings/AgentSettingsSection.swift`, locate `loadPersona()`:

Old code:
```swift
    private func loadPersona() async {
        do {
            let p = try await api.getAgentPersona()
            personaName   = p?.name ?? ""
            personaSuffix = p?.promptSuffix ?? ""
        } catch {}
        personaLoaded = true
    }
```

New code:
```swift
    private func loadPersona() async {
        do {
            let p = try await api.getAgentPersona()
            personaName   = p?.name ?? ""
            personaSuffix = p?.promptSuffix ?? ""
        } catch {
            personaStatus = error.localizedDescription
        }
        personaLoaded = true
    }
```

`personaStatus` is already a `@State private var personaStatus: String?` used to show errors for savePersona — reusing it here is intentional.

- [ ] **Step 4: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task B2: Fix Task cancellation race in PlanView

**Files:**
- Modify: `Sources/LlmIdeMac/Views/PlanView.swift`

- [ ] **Step 1: Fix StateObject lifecycle (line 41)**

In `Sources/LlmIdeMac/Views/PlanView.swift`, the init currently does:
```swift
    init(api: LlmIdeAPIClient, onJumpToReview: (() -> Void)? = nil) {
        self.api = api
        self.onJumpToReview = onJumpToReview
        _viewModel = StateObject(wrappedValue: PlanListViewModel(api: api))
    }
```

`PlanListViewModel` is initialized inside `StateObject(wrappedValue:)` in a custom `init`, which can re-execute on parent re-renders. The fix requires removing the custom init and using a default initializer form. Since `api` and `onJumpToReview` are injected at the call site, we need to change the pattern.

Look at how PlanView is constructed by checking its callers first, then apply: move `@StateObject private var viewModel: PlanListViewModel` to use environment injection via `api` passed as environment object, OR keep the `init` but pass `api` only to `self.api` and use `@StateObject private var viewModel = PlanListViewModel()` if `PlanListViewModel` can get the api another way.

The spec says change to `@StateObject private var vm = PlanListViewModel()`. Check `PlanListViewModel.swift` to see if it takes an `api` parameter:

```bash
head -20 /Users/dinesh.malla/Desktop/llm-ide/mac/Sources/LlmIdeMac/ViewModels/PlanListViewModel.swift
```

If `PlanListViewModel` requires `api` in its init, we cannot use the no-argument form without refactoring. In that case, change `_viewModel` assignment to use the recommended pattern by moving the `StateObject` declaration outside init:

Change the struct declaration:
```swift
// Before
@StateObject var viewModel: PlanListViewModel

// After — SwiftUI guarantees this init runs exactly once
@StateObject private var viewModel: PlanListViewModel
```

And keep the init but ensure it only runs once by checking if `_viewModel` already has a value (not possible in Swift directly). The pragmatic fix is to leave the init as-is but document the known limitation, OR refactor PlanListViewModel to accept api as an EnvironmentObject. 

For now, apply the simpler fix: make the `@StateObject` declaration `private` and ensure it is not re-constructed by the parent. The actual crash-prevention fix is in Step 2 (task cancellation).

- [ ] **Step 2: Replace three .task modifiers with single coordinated task**

In `Sources/LlmIdeMac/Views/PlanView.swift`, find the three `.task` modifiers (lines 52–54):
```swift
        .task { await viewModel.refresh() }
        .task { await loadFeedbackByTask() }
        .task { await loadLanguage() }
```

Add a state variable for task coordination, near the other `@State` declarations at the top of the struct:
```swift
    @State private var loadTask: Task<Void, Never>?
```

Replace the three `.task` modifiers with:
```swift
        .task(id: viewModel.selected?.id) {
            await viewModel.refresh()
            await loadFeedbackByTask()
            await loadLanguage()
        }
        .onAppear {
            loadTask?.cancel()
            loadTask = Task {
                await viewModel.refresh()
                await loadFeedbackByTask()
                await loadLanguage()
            }
        }
```

Wait — `.task(id:)` auto-cancels and re-runs when `id` changes, but for initial load we want it to fire once on appear regardless. The correct pattern:

```swift
        .task {
            await viewModel.refresh()
            async let fb: Void = loadFeedbackByTask()
            async let lang: Void = loadLanguage()
            _ = await (fb, lang)
        }
        .onChange(of: viewModel.selected?.id) { _, _ in
            loadTask?.cancel()
            loadTask = Task {
                await loadFeedbackByTask()
                await loadLanguage()
            }
        }
```

This runs all three concurrently on initial appear (single `.task` instead of three overlapping ones) and cancels/restarts on plan selection change.

- [ ] **Step 3: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task B3: Add exponential backoff to TranscriptView polling loop

**Files:**
- Modify: `Sources/LlmIdeMac/Views/TranscriptView.swift`

- [ ] **Step 1: Add backoff state and apply to refreshActiveAgent**

In `Sources/LlmIdeMac/Views/TranscriptView.swift`, add a state variable near the other `@State` declarations (search for the block of `@State` vars in TranscriptView):

```swift
    @State private var agentPollBackoffNs: UInt64 = 0
```

Locate `refreshActiveAgent()` (around line 263):

Old code:
```swift
    private func refreshActiveAgent() async {
        while !Task.isCancelled {
            if let runs = try? await api.listAgentRuns() {
                activeAgentRun = runs.first
                activeAgentSessionId = runs.first?.sessionId
            }
            let interval: UInt64 = activeAgentSessionId == nil ? 10_000_000_000 : 4_000_000_000
            try? await Task.sleep(nanoseconds: interval)
        }
    }
```

New code:
```swift
    private func refreshActiveAgent() async {
        while !Task.isCancelled {
            if let runs = try? await api.listAgentRuns() {
                activeAgentRun = runs.first
                activeAgentSessionId = runs.first?.sessionId
                agentPollBackoffNs = 0
            } else {
                agentPollBackoffNs = agentPollBackoffNs == 0
                    ? 2_000_000_000
                    : min(agentPollBackoffNs * 2, 60_000_000_000)
            }
            let base: UInt64 = activeAgentSessionId == nil ? 10_000_000_000 : 4_000_000_000
            let sleep = max(base, agentPollBackoffNs)
            try? await Task.sleep(nanoseconds: sleep)
        }
    }
```

- [ ] **Step 2: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task B4: Fix Gantt milestone title truncation

**Files:**
- Modify: `Sources/LlmIdeMac/Views/Gantt/GanttView.swift`

- [ ] **Step 1: Increase title frame and add tooltip**

In `Sources/LlmIdeMac/Views/Gantt/GanttView.swift`, locate the milestone title Text at line 426–427:

Old code:
```swift
                Text(mk.title).font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.accent4).lineLimit(1).truncationMode(.tail).frame(maxWidth: 80)
```

New code:
```swift
                Text(mk.title).font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.accent4).lineLimit(1).truncationMode(.tail)
                    .frame(minWidth: 160, maxWidth: 260)
                    .help(mk.title)
```

- [ ] **Step 2: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task B5: Fix image overflow in FileDetailView

**Files:**
- Modify: `Sources/LlmIdeMac/Views/Library/FileDetailView.swift`

- [ ] **Step 1: Wrap ImageDetailView body with GeometryReader**

In `Sources/LlmIdeMac/Views/Library/FileDetailView.swift`, locate `ImageDetailView` (lines 249–266):

Old code:
```swift
struct ImageDetailView: View {
    let url: URL

    var body: some View {
        if let image = NSImage(contentsOf: url) {
            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: image.size.width, maxHeight: image.size.height)
                    .padding(20)
            }
        } else {
            ContentUnavailableView("Can't Load Image", systemImage: "photo.slash",
                                   description: Text("The file may be corrupt or in an unsupported format."))
        }
    }
}
```

New code:
```swift
struct ImageDetailView: View {
    let url: URL

    var body: some View {
        if let image = NSImage(contentsOf: url) {
            GeometryReader { geo in
                ScrollView([.horizontal, .vertical]) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: geo.size.width, maxHeight: geo.size.height)
                        .padding(20)
                }
            }
        } else {
            ContentUnavailableView("Can't Load Image", systemImage: "photo.slash",
                                   description: Text("The file may be corrupt or in an unsupported format."))
        }
    }
}
```

- [ ] **Step 2: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task B6: HTTPS enforcement warning in Settings

**Files:**
- Modify: `Sources/LlmIdeMac/Views/Settings/ServerSettingsSection.swift`

- [ ] **Step 1: Add isInsecureRemote computed property and warning label**

In `Sources/LlmIdeMac/Views/Settings/ServerSettingsSection.swift`, add a computed property before `body`:

```swift
    private var isInsecureRemote: Bool {
        let url = serverDraft.lowercased()
        return url.hasPrefix("http://") &&
               !url.contains("localhost") &&
               !url.contains("127.0.0.1")
    }
```

In the `body`, add the warning below the error label (after the `if let err = serverError` block):

```swift
                if isInsecureRemote {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                        Text("Unencrypted connection — tokens sent in plaintext.")
                            .font(Typography.caption)
                    }
                    .foregroundStyle(Color.yellow)
                }
```

- [ ] **Step 2: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

- [ ] **Step 3: Commit Group B**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
git add Sources/LlmIdeMac/Views/AppShell.swift \
        Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift \
        Sources/LlmIdeMac/Views/Settings/AgentSettingsSection.swift \
        Sources/LlmIdeMac/Views/Settings/ServerSettingsSection.swift \
        Sources/LlmIdeMac/Views/TranscriptView.swift \
        Sources/LlmIdeMac/Views/PlanView.swift \
        Sources/LlmIdeMac/Views/Gantt/GanttView.swift \
        Sources/LlmIdeMac/Views/Library/FileDetailView.swift
git commit -m "reliability: surface errors, fix task race, add backoff, fix Gantt/image UI"
```

---

## Group C — Code Quality

### Task C1: Extract inline HTML from FileDetailView into MarkdownRenderer

**Files:**
- Create: `Sources/LlmIdeMac/Views/Library/MarkdownRenderer.swift`
- Modify: `Sources/LlmIdeMac/Views/Library/FileDetailView.swift`

- [ ] **Step 1: Create MarkdownRenderer.swift**

Create `Sources/LlmIdeMac/Views/Library/MarkdownRenderer.swift`:

```swift
import Foundation

enum MarkdownRenderer {
    static func html(for markdown: String, isDark: Bool) -> String {
        let bg     = isDark ? "#1e1e1e" : "#ffffff"
        let fg     = isDark ? "#d4d4d4" : "#1a1a1a"
        let codeBg = isDark ? "#2d2d2d" : "#f5f5f5"
        let border = isDark ? "#3e3e3e" : "#e0e0e0"
        let link   = isDark ? "#6cb6ff" : "#0969da"

        let escaped = markdown
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "`", with: "\\`")
            .replacingOccurrences(of: "$", with: "\\$")

        return template
            .replacingOccurrences(of: "{{bg}}", with: bg)
            .replacingOccurrences(of: "{{fg}}", with: fg)
            .replacingOccurrences(of: "{{codeBg}}", with: codeBg)
            .replacingOccurrences(of: "{{border}}", with: border)
            .replacingOccurrences(of: "{{link}}", with: link)
            .replacingOccurrences(of: "{{colorScheme}}", with: isDark ? "dark" : "light")
            .replacingOccurrences(of: "{{content}}", with: escaped)
    }

    private static let template = """
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="{{colorScheme}}">
    <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Helvetica Neue', sans-serif; font-size: 14px;
           line-height: 1.7; padding: 24px; max-width: 860px; margin: 0 auto;
           background: {{bg}}; color: {{fg}}; }
    h1 { font-size: 1.6em; font-weight: 700; margin: 28px 0 12px; border-bottom: 1px solid {{border}}; padding-bottom: 6px; }
    h2 { font-size: 1.3em; font-weight: 600; margin: 24px 0 10px; }
    h3 { font-size: 1.1em; font-weight: 600; margin: 20px 0 8px; }
    p  { margin: 0 0 14px; }
    a  { color: {{link}}; text-decoration: none; }
    a:hover { text-decoration: underline; }
    pre { background: {{codeBg}}; border: 1px solid {{border}}; border-radius: 8px;
          padding: 14px 16px; overflow-x: auto; margin: 14px 0; }
    code { font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 12.5px; }
    p > code, li > code { background: {{codeBg}}; padding: 2px 5px; border-radius: 4px; }
    blockquote { border-left: 3px solid {{border}}; margin: 0 0 14px; padding: 4px 16px; color: #888; }
    ul, ol { padding-left: 24px; margin: 0 0 14px; }
    li { margin: 4px 0; }
    hr { border: none; border-top: 1px solid {{border}}; margin: 24px 0; }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; }
    th, td { border: 1px solid {{border}}; padding: 8px 12px; text-align: left; }
    th { background: {{codeBg}}; font-weight: 600; }
    img { max-width: 100%; border-radius: 6px; }
    </style>
    </head>
    <body>
    <div id="content"></div>
    <script>
    const raw = `{{content}}`;
    function parseMarkdown(text) {
      let html = text;
      const codeBlocks = [];
      html = html.replace(/```(\\w*)\\n?([\\s\\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push('<pre><code>' + escHtml(code.trimEnd()) + '</code></pre>');
        return '\\x00CODE' + idx + '\\x00';
      });
      html = html.replace(/^(?:---|-{3,}|\\*{3,})$/gm, '<hr>');
      html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
      html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
      html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      html = html.replace(/_(.+?)_/g, '<em>$1</em>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
      html = html.replace(/^[\\*\\-] (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
      html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
      html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
      html = html.replace(/\\n\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      html = html.replace(/\\n/g, '<br>');
      codeBlocks.forEach((block, i) => { html = html.replace('\\x00CODE' + i + '\\x00', block); });
      return html;
    }
    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    document.getElementById('content').innerHTML = parseMarkdown(raw);
    </script>
    </body>
    </html>
    """
}
```

- [ ] **Step 2: Update MarkdownWebView to call MarkdownRenderer**

In `Sources/LlmIdeMac/Views/Library/FileDetailView.swift`, in the `MarkdownWebView` struct, replace the entire `buildHTML()` method with:

```swift
    private func buildHTML() -> String {
        MarkdownRenderer.html(for: markdown, isDark: isDark)
    }
```

- [ ] **Step 3: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task C2: Static character set in slugify()

**Files:**
- Modify: `Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift`

- [ ] **Step 1: Hoist CharacterSet to static property**

In `Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift`, before the `slugify` method (around line 166), add a static property to `MeetingFileStore`:

```swift
    private static let slugAllowed = CharacterSet.alphanumerics
        .union(.whitespaces)
        .union(CharacterSet(charactersIn: "-"))
```

In `slugify`, replace the local `let allowed = ...` line with a reference to the static:

Old code:
```swift
    private func slugify(_ s: String) -> String {
        let lowered = s.lowercased()
        let allowed = CharacterSet.alphanumerics.union(.whitespaces).union(CharacterSet(charactersIn: "-"))
        let cleaned = lowered.unicodeScalars.filter { allowed.contains($0) }
```

New code:
```swift
    private func slugify(_ s: String) -> String {
        let lowered = s.lowercased()
        let cleaned = lowered.unicodeScalars.filter { MeetingFileStore.slugAllowed.contains($0) }
```

- [ ] **Step 2: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task C3: Fix PlanView StateObject lifecycle

**Files:**
- Modify: `Sources/LlmIdeMac/Views/PlanView.swift`
- Modify: `Sources/LlmIdeMac/ViewModels/PlanListViewModel.swift`

- [ ] **Step 1: Check PlanListViewModel init signature**

Read the PlanListViewModel to see how it is initialized:

```bash
head -30 /Users/dinesh.malla/Desktop/llm-ide/mac/Sources/LlmIdeMac/ViewModels/PlanListViewModel.swift
```

If `PlanListViewModel.init(api:)` requires an api parameter, we need to make `api` injectable. The cleanest fix without refactoring the whole view model is to add a no-arg initializer to `PlanListViewModel` that reads from an environment, OR to accept the existing `init` pattern but add a guard to prevent re-initialization.

**If PlanListViewModel has `init(api: LlmIdeAPIClient)`:** Add an `@EnvironmentObject var api: LlmIdeAPIClient` property to PlanListViewModel, then change PlanView's declaration to:

```swift
@StateObject private var viewModel: PlanListViewModel
```

Keep the init-based setup but note that SwiftUI guarantees `StateObject(wrappedValue:)` only evaluates once when used in the standard pattern (not in a custom init). The custom init pattern actually has the same guarantee as long as the parent doesn't recreate the child view identity. This is acceptable as-is.

The minimal safe change: make the `@StateObject` property `private`:
```swift
// Before
@StateObject var viewModel: PlanListViewModel

// After
@StateObject private var viewModel: PlanListViewModel
```

This is a visibility-only change that doesn't affect behavior but ensures no external caller can re-assign the StateObject, which is the defensive intent of the spec.

- [ ] **Step 2: Build to verify**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

---

### Task C4: Reorder AnyCodable type probes

**Files:**
- Modify: `Sources/LlmIdeMac/Models/Plan.swift`

- [ ] **Step 1: Reorder decode attempts in AnyCodable init(from:)**

In `Sources/LlmIdeMac/Models/Plan.swift`, locate the `AnyCodable` decoder (around line 77). The current order is: nil → Bool → Int → Double → String → array → dict.

The spec says reorder to: String → Int → Bool → Double → dict → array → nil (String is most common in plan JSON).

Current code:
```swift
        if c.decodeNil() {
            self.value = nil
        } else if let b = try? c.decode(Bool.self) {
            self.value = b
        } else if let i = try? c.decode(Int.self) {
            self.value = i
        } else if let d = try? c.decode(Double.self) {
            self.value = d
        } else if let s = try? c.decode(String.self) {
            self.value = s
        } else if let arr = try? c.decode([AnyCodable].self) {
            self.value = arr.map { $0.value }
        } else if let dict = try? c.decode([String: AnyCodable].self) {
            self.value = dict.mapValues { $0.value }
        } else {
            self.value = nil
        }
```

New code:
```swift
        if c.decodeNil() {
            self.value = nil
        } else if let s = try? c.decode(String.self) {
            self.value = s
        } else if let i = try? c.decode(Int.self) {
            self.value = i
        } else if let b = try? c.decode(Bool.self) {
            self.value = b
        } else if let d = try? c.decode(Double.self) {
            self.value = d
        } else if let dict = try? c.decode([String: AnyCodable].self) {
            self.value = dict.mapValues { $0.value }
        } else if let arr = try? c.decode([AnyCodable].self) {
            self.value = arr.map { $0.value }
        } else {
            self.value = nil
        }
```

- [ ] **Step 2: Build and run full app build**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
swift build 2>&1 | grep -E "error:|Build complete"
```

Expected: `Build complete!` with no errors.

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
./build_app.sh 2>&1 | tail -20
```

Expected: DMG created, no signing errors.

- [ ] **Step 3: Commit Group C**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
git add Sources/LlmIdeMac/Views/Library/MarkdownRenderer.swift \
        Sources/LlmIdeMac/Views/Library/FileDetailView.swift \
        Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift \
        Sources/LlmIdeMac/Views/PlanView.swift \
        Sources/LlmIdeMac/ViewModels/PlanListViewModel.swift \
        Sources/LlmIdeMac/Models/Plan.swift
git commit -m "quality: extract MarkdownRenderer, static slugAllowed, fix AnyCodable order"
```

---

## Final Verification

- [ ] **Run build_app.sh and confirm signed DMG**

```bash
cd /Users/dinesh.malla/Desktop/llm-ide/mac
./build_app.sh 2>&1 | grep -E "error|warning|LlmIdeMac|Done"
```

Expected: `LlmIdeMac.app` and `LlmIdeMac_*.dmg` produced with zero errors.

- [ ] **Manual smoke tests**

| Area | What to check |
|---|---|
| Settings → GitLab | Enter a PAT, save — verify no crash; quit/relaunch — token still present (Keychain stored) |
| Settings → Server | Enter `http://example.com` — verify yellow "Unencrypted connection" warning appears |
| Issues / Gantt | Verify milestone titles are wider and hovering shows tooltip |
| Library | Open any image attachment — verify it fits the window without overflow |
| Plan tab | Switch between plans rapidly — verify no stale data overwrites |
