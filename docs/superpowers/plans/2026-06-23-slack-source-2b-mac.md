# Slack Source — Phase 2b (Mac Client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Mac client to the Slack server connector (Phase 2a): a `SlackSource: InputSource` that fetches per channel and writes one transcript note per channel-window, plus its API client, config, settings card, and registry entry.

**Architecture:** Mirror the email client. `LlmIdeAPIClient+Slack` calls the `/kb/slack/{test,fetch,seen}` routes; `SavedSlackSource` (in `AppConfig`) holds the channel list + enabled flag (bot token lives in the vault). `SlackSource` (Phase-1 `InputSource`, `.fetch`) loops the configured channels and builds one `platform: "slack"` note per channel via the meeting pipeline. `SourceRegistry` gains `SlackSource()`; Phase-1 classification surfaces the notes under a "Slack" Library sub-group.

**Tech Stack:** Swift / SwiftUI (`mac/`). Build: `GIT_CONFIG_GLOBAL=/dev/null swift build` from `mac/` with `dangerouslyDisableSandbox: true` on the Bash tool. `swift test` does NOT run on this box (no `xctest`); write tests (CI runs them), verify locally with `swift build`.

**Spec:** `docs/superpowers/specs/2026-06-23-slack-source-design.md` (Phase 2a server is already merged).

> **Twins to clone:** `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Email.swift`, `mac/Sources/LlmIdeMac/Sources/EmailSource.swift`, `SavedEmailSource` + `emailSource` in `mac/Sources/LlmIdeMac/Models/Config.swift`, `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift`, and the email card + `runImport` in `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift`. Slack differs: a per-channel loop, ONE note per channel-window (not per message), and per-channel high-water.

---

### Task 1: `SavedSlackSource` config + `LlmIdeAPIClient+Slack`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift` (add `SavedSlackSource` struct + `@Published slackSource` + load)
- Create: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift`

- [ ] **Step 1: Add `SavedSlackSource` to `Config.swift`**

Immediately after the `SavedEmailSource` struct (search `struct SavedEmailSource`), add:

```swift
struct SavedSlackSource: Codable, Equatable {
    var displayName: String = ""
    /// Slack channel IDs (e.g. "C0123ABCD") the bot is invited to.
    var channels: [String] = []
    var lookbackDays: Int = 7
    var enabled: Bool = true

    init() {}

    /// Tolerant decoder — every field falls back to its default when absent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayName  = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        channels     = try c.decodeIfPresent([String].self, forKey: .channels) ?? []
        lookbackDays = try c.decodeIfPresent(Int.self, forKey: .lookbackDays) ?? 7
        enabled      = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}
```

- [ ] **Step 2: Add the `@Published slackSource` property**

Immediately after the `emailSource` property block (search `@Published var emailSource`), add:

```swift
    @Published var slackSource: SavedSlackSource? {
        didSet {
            if let s = slackSource, let data = try? AppJSON.encoder.encode(s) {
                defaults.set(data, forKey: "slackSource")
            } else {
                defaults.removeObject(forKey: "slackSource")
            }
        }
    }
```

- [ ] **Step 3: Load `slackSource` in `init`**

Immediately after the `emailSource` load block (search `data(forKey: "emailSource")`), add:

```swift
        if let data = defaults.data(forKey: "slackSource"),
           let decoded = decodeConfigOrStash(SavedSlackSource.self, key: "slackSource", data: data, defaults: defaults) {
            self.slackSource = decoded
        } else {
            self.slackSource = nil
        }
```

- [ ] **Step 4: Create the API client**

Create `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift`:

```swift
import Foundation

typealias SlackMessage = LlmIdeAPIClient.SlackMessage
typealias SlackTestResult = LlmIdeAPIClient.SlackTestResult

// External Slack source endpoints. The bot token is written to the server
// vault via `setSecret` (key `slack.botToken`) — `/kb/slack/test` and
// `/kb/slack/fetch` read it back for the calling user. Mirrors +Email.
extension LlmIdeAPIClient {

    /// Result of `/kb/slack/test` — a token/auth probe.
    struct SlackTestResult: Decodable {
        let ok: Bool
        let team: String
        let user: String
    }

    /// One fetched Slack message. `ts` is the stable dedup key (channel-scoped
    /// Slack timestamp); `id` aliases `channelId+ts` for SwiftUI Identifiable.
    struct SlackMessage: Decodable, Identifiable {
        let ts: String
        let channelId: String
        let user: String
        let text: String
        let threadTs: String?
        var id: String { "\(channelId):\(ts)" }
    }

    struct SlackSkipped: Decodable { let overCap: Int }

    /// `/kb/slack/fetch` result: new (server-deduped) messages + skip counts.
    struct SlackFetchResult: Decodable {
        let messages: [SlackMessage]
        let skipped: SlackSkipped
    }

    /// Probe the Slack token without importing — confirms the vault token works.
    func testSlack() async throws -> SlackTestResult {
        struct Req: Encodable {}
        return try await post("/kb/slack/test", body: Req(), authenticated: true)
    }

    /// Fetch NEW messages for one channel. The server owns the forward-only
    /// per-channel high-water + seen-ledger, so it returns only not-yet-imported
    /// messages (device-independent, no client dedup).
    func fetchSlack(channelId: String) async throws -> SlackFetchResult {
        struct Req: Encodable { let channelId: String }
        return try await post("/kb/slack/fetch",
                              body: Req(channelId: channelId),
                              authenticated: true)
    }

    /// Mark message ts's imported (server dedup ledger) and, when `lastTs` is
    /// non-nil, advance the forward-only per-channel high-water.
    func markSlackSeen(channelId: String, messageTs: [String], lastTs: String?) async throws {
        struct Req: Encodable { let channelId: String; let messageTs: [String]; let lastTs: String? }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await post("/kb/slack/seen",
                                    body: Req(channelId: channelId, messageTs: messageTs, lastTs: lastTs),
                                    authenticated: true)
    }
}
```

- [ ] **Step 5: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6` (dangerouslyDisableSandbox: true)
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Config.swift mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift
git commit -m "feat(mac): SavedSlackSource config + LlmIdeAPIClient+Slack" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `SlackSource: InputSource` + registry registration

**Files:**
- Create: `mac/Sources/LlmIdeMac/Sources/SlackSource.swift`
- Modify: `mac/Sources/LlmIdeMac/Sources/SourceRegistry.swift` (add `SlackSource()`)
- Modify: `mac/Sources/LlmIdeMac/Views/Sources/InputSourceRegistry.swift` (remove the `slack` planned entry)
- Test: `mac/Tests/LlmIdeMacTests/SourceRegistryTests.swift` (add slack cases)

- [ ] **Step 1: Add the failing registry test cases**

In `mac/Tests/LlmIdeMacTests/SourceRegistryTests.swift`, add inside the struct:

```swift
    @Test("slack platform resolves to the slack source")
    func slackPlatform() {
        #expect(SourceRegistry.source(forPlatform: "slack").id == "slack")
    }

    @Test("slack is a registered fetch source")
    func slackIsFetch() {
        #expect(SourceRegistry.source(id: "slack")?.id == "slack")
        #expect(SourceRegistry.fetchSources.map(\.id).contains("slack"))
    }
```

(These FAIL until Steps 2-3 register `SlackSource`. On this box `swift test` can't run; they run on CI — verify locally via `swift build` after Step 4.)

- [ ] **Step 2: Create `SlackSource.swift`**

Create `mac/Sources/LlmIdeMac/Sources/SlackSource.swift`:

```swift
import Foundation

/// Ingested Slack. A fetch source: for each configured channel it pulls NEW
/// messages (server owns the forward-only per-channel high-water + seen-ledger)
/// and writes ONE transcript note per channel-window via the meeting pipeline
/// (`MeetingFileStore` + `MeetingSummarizationService`), so it lands in the
/// Library as a `platform: "slack"` source. Twin of `EmailSource`, but loops
/// channels and groups per channel instead of one-note-per-message.
struct SlackSource: InputSource {
    let id = "slack"
    let displayName = "Slack"
    let icon = "number"
    let emptyText = "No Slack messages yet"
    let platforms = ["slack"]
    let mode = SourceMode.fetch

    @MainActor
    func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult {
        guard let s = ctx.config.slackSource, s.enabled, !s.channels.isEmpty else { return .noSource }

        var totalImported = 0
        var totalMore = 0
        var failure: String?

        for channelId in s.channels {
            if Task.isCancelled { break }
            let result: LlmIdeAPIClient.SlackFetchResult
            do {
                result = try await ctx.api.fetchSlack(channelId: channelId)
            } catch {
                failure = error.localizedDescription
                break
            }
            let msgs = result.messages
            if msgs.isEmpty { continue }
            do {
                try await makeNote(channelId: channelId, messages: msgs, ctx: ctx)
            } catch {
                failure = error.localizedDescription
                break
            }
            totalImported += msgs.count
            totalMore += result.skipped.overCap

            // Advance the per-channel high-water ONLY on a clean drain (no
            // overCap) — otherwise leave it so the remainder re-fetches, like
            // EmailSource. Always record the fetched ts's as seen.
            let tsList = msgs.map(\.ts)
            let drained = result.skipped.overCap == 0
            let lastTs = drained ? tsList.max(by: { (Double($0) ?? 0) < (Double($1) ?? 0) }) : nil
            try? await ctx.api.markSlackSeen(channelId: channelId, messageTs: tsList, lastTs: lastTs)
        }

        if let failure { return .failure(failure, imported: totalImported) }
        if totalImported == 0 { return .none }
        return .imported(totalImported, moreAvailable: totalMore, oversize: 0)
    }

    /// Build ONE transcript note for a channel-window: messages oldest-first as
    /// "user: text", run through the meeting pipeline (AI summary + .docx).
    @MainActor
    private func makeNote(channelId: String, messages: [LlmIdeAPIClient.SlackMessage],
                          ctx: SourceContext) async throws {
        // Chronological order for a readable transcript (server returns newest-first).
        let ordered = messages.sorted { (Double($0.ts) ?? 0) < (Double($1.ts) ?? 0) }
        let firstTs = Double(ordered.first?.ts ?? "0") ?? 0
        let lastTs = ordered.last?.ts ?? "\(firstTs)"
        let startedAt = Date(timeIntervalSince1970: firstTs)
        let dateSlug = AppDateFormatter.dateHourMinuteLocal(startedAt)
        let title = "Slack #\(channelId) — \(dateSlug)"
        // Stable per-window id so a re-fetch of the same window overwrites
        // rather than duplicating on disk.
        let id = "slack-\(channelId)-\(lastTs)"
        let participants = Array(Set(ordered.map(\.user))).sorted()
        let transcript = ordered.map { "\($0.user): \($0.text)" }.joined(separator: "\n")
        let root = ctx.root
        let notesOutputFolder = ctx.notesOutputFolder
        let api = ctx.api

        try await Task.detached(priority: .background) {
            let store = MeetingFileStore(root: root)
            let handle = try store.createPartial(
                id: id, startedAt: startedAt, platform: "slack", language: "")
            for m in ordered {
                let when = Date(timeIntervalSince1970: Double(m.ts) ?? firstTs)
                try handle.appendCaption(timestamp: when, speaker: m.user, text: m.text)
            }
            try handle.flush()
            let url = try store.finalize(
                handle: handle, title: title, endedAt: Date(timeIntervalSince1970: Double(lastTs) ?? firstTs),
                participants: participants)

            let idSuffix = id.suffix(8)
            let docxURL = notesOutputFolder.appendingPathComponent("\(dateSlug)-\(idSuffix)-slack-notes.docx")
            await MeetingSummarizationService.run(
                api: api,
                transcript: transcript,
                title: title,
                language: "",
                startedAt: startedAt,
                durationSeconds: nil,
                participants: participants,
                transcriptFileURL: url,
                docxOutputURL: docxURL,
                root: root)
        }.value
    }
}
```

- [ ] **Step 3: Register in `SourceRegistry` + drop the planned entry**

In `mac/Sources/LlmIdeMac/Sources/SourceRegistry.swift`, change:
```swift
    static let all: [InputSource] = [MeetingSource(), EmailSource()]
```
to:
```swift
    static let all: [InputSource] = [MeetingSource(), EmailSource(), SlackSource()]
```

In `mac/Sources/LlmIdeMac/Views/Sources/InputSourceRegistry.swift`, remove the `slack` entry from the `planned` array (delete the `.init(id: "slack", ...)` line) — it's now live. Keep `calendar`/`documents`.

- [ ] **Step 4: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6`
Expected: `Build complete!` (Resolve any compile error against the real `MeetingFileStore`/`MeetingSummarizationService`/`AppDateFormatter` signatures by reading `mac/Sources/LlmIdeMac/Sources/EmailSource.swift` — they MUST match how EmailSource calls them.)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Sources/SlackSource.swift mac/Sources/LlmIdeMac/Sources/SourceRegistry.swift mac/Sources/LlmIdeMac/Views/Sources/InputSourceRegistry.swift mac/Tests/LlmIdeMacTests/SourceRegistryTests.swift
git commit -m "feat(mac): SlackSource (per-channel fetch → one note per window) + register" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Slack settings card + config sheet

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift` (clone of `EmailSourceSheet.swift`)
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` (add a Slack card + import runner)

- [ ] **Step 1: Create `SlackSourceSheet.swift`**

Read `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift` and clone it to `SlackSourceSheet.swift` with these changes (keep the same chrome, save/cancel, and the `setSecret`-on-save pattern):
- Bind to `config.slackSource` (a `SavedSlackSource`) instead of `emailSource`.
- Fields: a **bot token** secure field (saved via `api.setSecret(key: "slack.botToken", value:)`, blank = keep existing — mirror the email password handling), a **channels** field (comma-separated channel IDs → `channels: [String]` via `split(separator: ",").map { trimmed }.filter { !$0.isEmpty }`), and **lookback days** (Int stepper, clamp 1...60). Drop IMAP-only fields (host/port/secure/mailbox/unreadOnly/fromFilter).
- On Save: write the token to the vault if non-empty, set `config.slackSource = built`, dismiss.
- A "Test" button calling `api.testSlack()` and showing `team`/error, mirroring the email Test button.

(Match the exact view-model/state pattern of `EmailSourceSheet`; the field set is the only substantive difference.)

- [ ] **Step 2: Add the Slack card to `ConnectionsSettingsSection`**

Read the email card region in `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` (search the `emailCard`/`InputSourceCard` for email + its `runImport`). Add a parallel Slack card:
- An `InputSourceCard` titled "Slack" with subtitle from `config.slackSource` state (configured/enabled), a "Configure" action presenting `SlackSourceSheet`, and a "Fetch now" action calling a new `runSlackImport()`.
- `runSlackImport()` clones `runImport()` but calls `service.importSource(id: "slack")` and maps the `SourceIngestResult` to the card status text ("Imported N Slack message(s).", "No new messages.", noSource → clear, failure → "Fetch failed: …"). Reuse the same `SourceIngestService(...)` construction as `runImport`.
- Add Slack to the `.task` auto-fetch guard: after the email auto-fetch, add `if config.slackSource?.enabled == true { await runSlackImport() }` (or, cleaner, leave auto-fetch to email and make Slack fetch-on-demand via the card button — match whatever is least surprising; the card "Fetch now" is the required path).
- Remove the now-stale Slack "coming soon" card if `ConnectionsSettingsSection` rendered one from `InputSourceRegistry.planned` (it will no longer be in `planned` after Task 2, so the planned-loop drops it automatically — confirm no hardcoded Slack planned card remains).

- [ ] **Step 3: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift
git commit -m "feat(mac): Slack settings card + config sheet" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Final verification + mark spec implemented

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-slack-source-design.md` (status)

- [ ] **Step 1: Full build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -4` → `Build complete!`

- [ ] **Step 2: Confirm wiring**

Run:
```bash
cd /Users/dinesh.malla/llm-ide
grep -rn "SlackSource()" mac/Sources/LlmIdeMac/Sources/SourceRegistry.swift      # registered
grep -n "\"slack\"" mac/Sources/LlmIdeMac/Views/Sources/InputSourceRegistry.swift # expect: none (removed from planned)
```
Expected: `SlackSource()` present in the registry; no `"slack"` planned entry remains.

- [ ] **Step 3: Run the Mac suite (CI / full Xcode)**

On CI / full Xcode: `cd mac && swift test 2>&1 | tail -8` → all pass incl. the new `SourceRegistryTests` slack cases.

- [ ] **Step 4: Mark spec implemented + commit**

Change the spec's `**Status:**` to `Implemented 2026-06-23 (server 2a + Mac 2b)`. Then:
```bash
git add docs/superpowers/specs/2026-06-23-slack-source-design.md
git commit -m "docs(spec): mark Slack source fully implemented (2a + 2b)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Runtime verification (user)**

In the running app: Settings → Connections → Slack: paste a bot token (bot invited to the channel), add a channel ID, Test → shows the team; "Fetch now" → a "Slack #… " note appears in the Library SOURCES under a "Slack" sub-group; re-fetch with no new messages → "No new messages" and no duplicate note.

---

## Self-Review

- **Spec coverage:** `SlackSource: InputSource` (per-channel, one note/window, platform "slack") → Task 2; `LlmIdeAPIClient+Slack` (test/fetch/seen) → Task 1; `SavedSlackSource` (channels, enabled) + token via vault → Tasks 1 & 3; `SlackSourceSheet` + Connections card → Task 3; `SourceRegistry` registration + drop planned entry → Task 2; Phase-1 classification surfaces "Slack" sub-group automatically (no view change needed). ✔
- **Placeholder scan:** full code for `SavedSlackSource`, `+Slack`, `SlackSource`, registry edits, tests; the two UI clones (`SlackSourceSheet`, the Connections card) give exact field/behavior diffs against the named email twins (a faithful-clone instruction, not a vague placeholder). ✔
- **Type consistency:** `LlmIdeAPIClient.SlackMessage{ts,channelId,user,text,threadTs}`/`SlackFetchResult{messages,skipped:{overCap}}`/`testSlack()`/`fetchSlack(channelId:)`/`markSlackSeen(channelId:messageTs:lastTs:)` defined in Task 1 and used identically in `SlackSource` (Task 2) and the card runner (Task 3); `SavedSlackSource{channels,enabled,lookbackDays}` defined Task 1, read in Task 2/3; `SourceIngestResult.failure(_, imported:)` matches the Phase-1 enum; `SourceContext`/`MeetingFileStore`/`MeetingSummarizationService` usage mirrors the committed `EmailSource.swift`. ✔
