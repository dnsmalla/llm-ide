# Unified Input-Source Abstraction (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke, smeared handling of input sources (meetings, email) with one uniform `InputSource` protocol + `SourceRegistry`, so classification, Library display, and ingestion all flow through the registry — making a new source (Slack, Phase 2) a single entry.

**Architecture:** A new `Sources/` group defines `InputSource` (uniform protocol; live-capture sources use a default no-op ingestion), concrete `MeetingSource`/`EmailSource`, and `SourceRegistry` (the one declarative list + classification lookups). Email's fetch/ingest logic moves out of `SourceIngestService` into `EmailSource`; `SourceIngestService` becomes a generic driver. `LibraryItem.SourceKind` is retired in favor of `sourceId: String?` classified via the registry. Behavior-preserving refactor, Mac client only.

**Tech Stack:** Swift / SwiftUI (`mac/`), swift-testing (`import Testing`) for new tests, XCTest already present. Build: `GIT_CONFIG_GLOBAL=/dev/null swift build` from `mac/` — **you MUST set `dangerouslyDisableSandbox: true`** on the Bash tool (SwiftPM's nested sandbox fails otherwise). **`swift test` does NOT run on this dev box** (Command Line Tools only — no `xctest`; even `--build-tests` fails). Write tests (they run on CI / full Xcode); verify locally with `swift build` of the main target.

**Spec:** `docs/superpowers/specs/2026-06-23-input-source-abstraction-design.md`

> **Refinements vs spec (decided while reading the code):**
> - **`testConnection` is NOT added to the protocol.** It is only ever called from `EmailSourceSheet` (via `api.testEmail`); keeping it there avoids an abstraction with one real caller. The protocol's uniform surface is metadata + `fetchAndIngest`.
> - **No generic card-descriptor.** Source *config UI* is inherently per-source (email's IMAP sheet ≠ a future Slack token sheet), so `ConnectionsSettingsSection` keeps the email card. The registry still drives the source LIST, classification, Library display, and ingestion — which is where the shotgun surgery lived.
> - **`InputSourceRegistry` (the "coming soon" planned list) is KEPT**, not removed. Removing it would delete the Slack/Calendar/Documents announcement cards — a user-visible change, which this refactor forbids. Slack moves planned→live in Phase 2.

---

### Task 1: Core types — `SourceMode`, `SourceContext`, `SourceIngestResult`, `InputSource`

Define the abstraction. Move the existing `SourceIngestService.Result` enum out to a top-level `SourceIngestResult` so both the protocol and the service share it.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Sources/InputSource.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/SourceIngestService.swift` (remove the nested `Result` enum; reference the new top-level one)

- [ ] **Step 1: Create the core types**

Create `mac/Sources/LlmIdeMac/Sources/InputSource.swift`:

```swift
import Foundation

/// How a source produces content. `liveCapture` sources (meetings) are
/// event-driven and have no fetch; `fetch` sources (email, later Slack) pull
/// new items on demand. One protocol covers both — live-capture sources use
/// the default no-op `fetchAndIngest`.
enum SourceMode { case liveCapture, fetch }

/// Outcome of one source's `fetchAndIngest` run, surfaced on the Sources card.
/// (Relocated from `SourceIngestService.Result` so the protocol can use it.)
enum SourceIngestResult {
    case imported(Int, moreAvailable: Int, oversize: Int) // N notes; more left; large skipped
    case none                          // fetched, but nothing new
    case noSource                      // no configured/enabled source
    case failure(String)               // fetch or ingest error
}

/// Runtime dependencies a fetch source needs to ingest. Bundled so sources stay
/// stateless (`SourceRegistry.all` is a static list) while the driver injects
/// the live objects.
@MainActor
struct SourceContext {
    let api: LlmIdeAPIClient
    let config: AppConfig
    /// Notes-folder root for `MeetingFileStore`.
    let root: URL
    /// `<project>/notes/` — where the AI `.docx` note is written.
    let notesOutputFolder: URL
}

/// A unified input source. Metadata classifies files and drives the Library
/// SOURCES UI; `fetchAndIngest` pulls new content (fetch sources only — live
/// capture sources inherit the no-op default and are driven by their own
/// engine, e.g. `AutoCaptureService`).
protocol InputSource {
    /// Stable id, e.g. "meeting", "email". Stored on `LibraryItem.sourceId`.
    var id: String { get }
    /// Library SOURCES sub-group label.
    var displayName: String { get }
    /// SF Symbol for the sub-group + cards.
    var icon: String { get }
    /// Muted text shown when the sub-group has no files.
    var emptyText: String { get }
    /// Frontmatter `platform` values (lowercased) that classify a file to this
    /// source. e.g. email → ["email"]; meeting → ["meet","teams","zoom","mic"].
    var platforms: [String] { get }
    var mode: SourceMode { get }
    /// Pull new content and write it into the project. Returns the outcome.
    /// Default no-op for `.liveCapture` sources.
    @MainActor func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult
}

extension InputSource {
    @MainActor func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult { .none }
}
```

- [ ] **Step 2: Remove the nested `Result` enum from `SourceIngestService`**

In `mac/Sources/LlmIdeMac/Services/SourceIngestService.swift`, delete the nested enum (currently lines ~31-37):

```swift
    /// Outcome of one `importNewEmails()` run, surfaced on the Sources card.
    enum Result {
        case imported(Int, moreAvailable: Int, oversize: Int) // N notes; more left; large skipped
        case none                          // fetched, but nothing new
        case noSource                      // no configured/enabled email source
        case failure(String)               // fetch or ingest error
    }
```

Then change the `importNewEmails()` return type and the two internal references from `Result`/`.failure`/`.none`/`.imported`/`.noSource` to the top-level `SourceIngestResult` (the case names are identical, so only the function's declared return type `-> Result` becomes `-> SourceIngestResult`; bare `.failure(...)` etc. still resolve via the return-type context). Update the signature line:

```swift
    func importNewEmails() async -> SourceIngestResult {
```

- [ ] **Step 3: Build to verify it compiles**

Run (Bash with `dangerouslyDisableSandbox: true`): `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6`
Expected: `Build complete!` If a call site references `SourceIngestService.Result`, update it to `SourceIngestResult` (Task 3 covers `ConnectionsSettingsSection`; if the compiler flags it now, fix it there too).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Sources/InputSource.swift mac/Sources/LlmIdeMac/Services/SourceIngestService.swift
git commit -m "feat(mac): InputSource protocol + SourceContext/Result core types" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `MeetingSource`, `EmailSource`, `SourceRegistry`

Define the two concrete sources and the registry. Email's fetch/ingest logic moves here from `SourceIngestService` (the service becomes a driver in Task 3).

**Files:**
- Create: `mac/Sources/LlmIdeMac/Sources/MeetingSource.swift`
- Create: `mac/Sources/LlmIdeMac/Sources/EmailSource.swift`
- Create: `mac/Sources/LlmIdeMac/Sources/SourceRegistry.swift`
- Test: `mac/Tests/LlmIdeMacTests/SourceRegistryTests.swift`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SourceRegistryTests.swift`:

```swift
import Testing
@testable import LlmIdeMac

/// The registry is the single place sources are declared and looked up.
struct SourceRegistryTests {
    @Test("email platform resolves to the email source")
    func emailPlatform() {
        #expect(SourceRegistry.source(forPlatform: "email").id == "email")
        #expect(SourceRegistry.source(forPlatform: "EMAIL").id == "email")
    }

    @Test("meeting platforms resolve to the meeting source")
    func meetingPlatforms() {
        for p in ["meet", "teams", "zoom", "mic", "Meet"] {
            #expect(SourceRegistry.source(forPlatform: p).id == "meeting")
        }
    }

    @Test("unknown or empty platform defaults to the meeting source")
    func unknownDefaults() {
        #expect(SourceRegistry.source(forPlatform: "").id == "meeting")
        #expect(SourceRegistry.source(forPlatform: "slack").id == "meeting")
    }

    @Test("id lookup finds registered sources, nil otherwise")
    func idLookup() {
        #expect(SourceRegistry.source(id: "email")?.id == "email")
        #expect(SourceRegistry.source(id: "meeting")?.id == "meeting")
        #expect(SourceRegistry.source(id: "nope") == nil)
    }

    @Test("fetchSources contains fetch sources and excludes live capture")
    func fetchSources() {
        let ids = SourceRegistry.fetchSources.map(\.id)
        #expect(ids.contains("email"))
        #expect(!ids.contains("meeting"))
    }

    @Test("every source has display metadata")
    func metadata() {
        for s in SourceRegistry.all {
            #expect(!s.displayName.isEmpty)
            #expect(!s.icon.isEmpty)
            #expect(!s.emptyText.isEmpty)
            #expect(!s.platforms.isEmpty)
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails (CI / full Xcode)**

On CI / full Xcode: `cd mac && swift test --filter SourceRegistryTests 2>&1 | tail -15`
Expected: FAIL — `SourceRegistry` undefined. (Locally this can't run; proceed to implement and rely on `swift build`.)

- [ ] **Step 3: Create `MeetingSource`**

Create `mac/Sources/LlmIdeMac/Sources/MeetingSource.swift`:

```swift
import Foundation

/// Captured meetings (Zoom/Teams/Meet/mic). Live capture is event-driven and
/// owned by `AutoCaptureService` + `CaptionOrchestrator`; this type only
/// supplies classification + Library SOURCES metadata, so it inherits the
/// default no-op `fetchAndIngest`.
struct MeetingSource: InputSource {
    let id = "meeting"
    let displayName = "Meetings"
    let icon = "waveform.and.mic"
    let emptyText = "No meeting files yet"
    let platforms = ["meet", "teams", "zoom", "mic"]
    let mode = SourceMode.liveCapture
}
```

- [ ] **Step 4: Create `EmailSource` (move the email ingest logic here)**

Create `mac/Sources/LlmIdeMac/Sources/EmailSource.swift` with the relocated logic (this is `SourceIngestService.importNewEmails()` + `makeNote()` minus the `rescanAndNotify`, which the driver now does once, and with `self.api/config/root/notesOutputFolder` replaced by `ctx.*`):

```swift
import Foundation

/// Ingested email. A fetch source: pulls NEW mail (the server owns the
/// forward-only high-water mark + seen-ledger), turns each message into a
/// meeting note via the exact meeting pipeline (`MeetingFileStore` +
/// `MeetingSummarizationService`), then advances the mark. Moved out of
/// `SourceIngestService` so the service is a generic driver.
struct EmailSource: InputSource {
    let id = "email"
    let displayName = "Mail"          // Library SOURCES sub-group label
    let icon = "envelope"
    let emptyText = "No mail yet"
    let platforms = ["email"]
    let mode = SourceMode.fetch

    /// Safety cap on notes created per fetch (first big drain imports the
    /// newest N; the high-water is NOT advanced when capped, so the remainder
    /// re-fetches next run rather than being lost).
    private static let maxPerRun = 50

    @MainActor
    func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult {
        guard let source = ctx.config.emailSource, source.enabled else { return .noSource }

        let fetchStart = Date()
        let result: LlmIdeAPIClient.EmailFetchResult
        do {
            result = try await ctx.api.fetchEmails(source)
        } catch {
            return .failure(error.localizedDescription)
        }

        let messages = result.messages
        guard !messages.isEmpty else {
            try? await ctx.api.markEmailSeen(messageIds: [], lastFetchedAt: fetchStart)
            return .none
        }

        let batch = Array(messages.prefix(Self.maxPerRun))
        let capped = messages.count > batch.count

        var importedIds: [String] = []
        var failure: String?
        for msg in batch {
            if Task.isCancelled { break }
            do {
                try await makeNote(from: msg, ctx: ctx)
                importedIds.append(msg.messageId)
            } catch {
                failure = error.localizedDescription
                break
            }
        }
        let cancelled = Task.isCancelled

        let drained = !capped && failure == nil && !cancelled
        try? await ctx.api.markEmailSeen(messageIds: importedIds,
                                         lastFetchedAt: drained ? fetchStart : nil)

        if let failure { return .failure(failure) }
        let moreAvailable = (messages.count - batch.count) + result.skipped.overCap
        return .imported(importedIds.count, moreAvailable: moreAvailable,
                         oversize: result.skipped.oversize)
    }

    /// Create a `.md` transcript via `MeetingFileStore`, finalize it, then run
    /// `MeetingSummarizationService` for the AI summary + `.docx`. The email
    /// body plays the role of the transcript. File + summarize work runs off
    /// the main actor.
    @MainActor
    private func makeNote(from msg: EmailMessage, ctx: SourceContext) async throws {
        let startedAt = AppDateFormatter.parseISO(msg.date) ?? Date()
        let title = msg.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Email" : msg.subject
        let participants = msg.from.isEmpty ? [] : [msg.from]
        let speaker = msg.from.isEmpty ? "Email" : msg.from
        let body = msg.text
        let transcript = """
        From: \(msg.from)
        Subject: \(msg.subject)
        Date: \(msg.date)

        \(body)
        """
        let id = msg.messageId.isEmpty ? UUID().uuidString : msg.messageId
        let root = ctx.root
        let notesOutputFolder = ctx.notesOutputFolder
        let api = ctx.api

        try await Task.detached(priority: .background) {
            let store = MeetingFileStore(root: root)
            let handle = try store.createPartial(
                id: id, startedAt: startedAt, platform: "email", language: "")
            try handle.appendCaption(timestamp: startedAt, speaker: speaker, text: body)
            try handle.flush()
            let url = try store.finalize(
                handle: handle, title: title, endedAt: startedAt, participants: participants)

            let dateSlug = AppDateFormatter.dateHourMinuteLocal(startedAt)
            let idSuffix = id.prefix(8)
            let docxURL = notesOutputFolder.appendingPathComponent(
                "\(dateSlug)-\(idSuffix)-email-notes.docx")
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

- [ ] **Step 5: Create `SourceRegistry`**

Create `mac/Sources/LlmIdeMac/Sources/SourceRegistry.swift`:

```swift
import Foundation

/// The single declarative list of input sources and the lookups everything
/// source-related uses (classification, Library SOURCES display, ingestion).
/// Adding a source is one entry here plus its `InputSource` struct.
enum SourceRegistry {
    static let all: [InputSource] = [MeetingSource(), EmailSource()]

    /// Match a frontmatter `platform` value to its source. Unknown/empty →
    /// the meeting source (preserves the historical default-to-meeting).
    static func source(forPlatform platform: String) -> InputSource {
        let key = platform.lowercased()
        return all.first { $0.platforms.contains(key) } ?? MeetingSource()
    }

    static func source(id: String) -> InputSource? {
        all.first { $0.id == id }
    }

    /// Sources the ingestion driver should poll (live-capture is excluded —
    /// it's driven by its own engine).
    static var fetchSources: [InputSource] {
        all.filter { $0.mode == .fetch }
    }
}
```

- [ ] **Step 6: Build, then run the test on CI**

Locally: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6` → `Build complete!`
On CI / full Xcode: `swift test --filter SourceRegistryTests` → all pass.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Sources/MeetingSource.swift mac/Sources/LlmIdeMac/Sources/EmailSource.swift mac/Sources/LlmIdeMac/Sources/SourceRegistry.swift mac/Tests/LlmIdeMacTests/SourceRegistryTests.swift
git commit -m "feat(mac): MeetingSource/EmailSource + SourceRegistry; move email ingest" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `SourceIngestService` becomes a generic driver

The service now builds the `SourceContext` and drives the registry's fetch sources, owning the one-time rescan/notify. The email-specific body is gone (moved to `EmailSource`).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SourceIngestService.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` (type rename only, if the compiler requires it)

- [ ] **Step 1: Replace the body of `SourceIngestService`**

Replace everything from after the stored properties (keep `api`, `config`, `root`, `notesOutputFolder`, `indexer`) down through `makeNote` with the driver below. The fields stay; `maxPerRun`, `importNewEmails`'s email body, and `makeNote` are removed (now in `EmailSource`). Keep `rescanAndNotify`.

```swift
@MainActor
struct SourceIngestService {
    let api: LlmIdeAPIClient
    let config: AppConfig
    /// Notes-folder root for `MeetingFileStore`.
    let root: URL
    /// `<project>/notes/` — where the AI `.docx` note is written.
    let notesOutputFolder: URL
    /// Forces the Library SQLite index to pick up new files immediately.
    let indexer: FolderIndexer

    private var context: SourceContext {
        SourceContext(api: api, config: config, root: root, notesOutputFolder: notesOutputFolder)
    }

    /// Fetch + ingest a single source by id (used by the Sources card, which
    /// shows that source's specific outcome). Runs one rescan/notify after.
    func importSource(id: String) async -> SourceIngestResult {
        guard let source = SourceRegistry.source(id: id) else { return .noSource }
        let result = await source.fetchAndIngest(context)
        await rescanAndNotify()
        return result
    }

    /// Back-compat entry point for the email Sources card.
    func importNewEmails() async -> SourceIngestResult {
        await importSource(id: "email")
    }

    /// Fetch + ingest every fetch source, then one rescan/notify. Returns the
    /// per-source outcomes keyed by source id. (Forward-looking: today only
    /// email is a fetch source; a new fetch source is picked up automatically.)
    func importAll() async -> [String: SourceIngestResult] {
        var results: [String: SourceIngestResult] = [:]
        for source in SourceRegistry.fetchSources {
            results[source.id] = await source.fetchAndIngest(context)
        }
        await rescanAndNotify()
        return results
    }

    /// One full re-index after ingest + the Library refresh, off-main.
    private func rescanAndNotify() async {
        let indexer = self.indexer
        await Task.detached(priority: .background) { try? indexer.fullScan() }.value
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }
}
```

Update the file's top doc-comment to describe a generic driver rather than email specifically.

- [ ] **Step 2: Fix the `ConnectionsSettingsSection` type reference if needed**

The Sources card calls `service.importNewEmails()` and switches on the result. The case names are unchanged; only a type annotation referencing `SourceIngestService.Result` (if any) needs to become `SourceIngestResult`. Run:
```bash
grep -n "SourceIngestService.Result\|importNewEmails\|SourceIngestResult" mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift
```
If a `SourceIngestService.Result` annotation exists, change it to `SourceIngestResult`. The `switch await service.importNewEmails()` call and its `case .imported/.none/.noSource/.failure` arms need no change.

- [ ] **Step 3: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6` → `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SourceIngestService.swift mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift
git commit -m "refactor(mac): SourceIngestService is a registry-driven driver" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Retire `LibraryItem.SourceKind` → `sourceId`, classify via registry

Replace the `SourceKind` enum with a `sourceId: String?` set from the registry; update the Library SOURCES rendering to iterate the registry.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LibraryItem.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift`
- Modify/Replace test: `mac/Tests/LlmIdeMacTests/LibraryItemSourceKindTests.swift` → `LibraryItemSourceClassificationTests.swift`

- [ ] **Step 1: Update the test (migrate to the new API)**

Replace the contents of `mac/Tests/LlmIdeMacTests/LibraryItemSourceKindTests.swift` (and rename the file to `LibraryItemSourceClassificationTests.swift`) with:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

/// Classification of `source/` `.md` files into SOURCES sub-groups now hinges
/// on `SourceRegistry` (frontmatter `platform` → source id).
struct LibraryItemSourceClassificationTests {
    @Test(".meetings category is titled Sources; others keep their name")
    func sectionTitle() {
        #expect(LibraryItem.Category.meetings.sectionTitle == "Sources")
        #expect(LibraryItem.Category.code.sectionTitle == "Code")
        #expect(LibraryItem.Category.notes.sectionTitle == "Notes")
        #expect(LibraryItem.Category.data.sectionTitle == "Data")
    }

    private func writeMD(_ contents: String) throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("srcid-\(UUID().uuidString).md")
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    @Test("reads platform: email from frontmatter as the email source")
    func readsEmail() throws {
        let url = try writeMD("---\nid: abc\ntitle: Re: Q3\nplatform: email\n---\nbody")
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(LibraryItemStore.sourceId(for: url) == "email")
    }

    @Test("reads a captured-meeting platform as the meeting source")
    func readsMeeting() throws {
        let url = try writeMD("---\nid: def\ntitle: Standup\nplatform: meet\n---\nx")
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(LibraryItemStore.sourceId(for: url) == "meeting")
    }

    @Test("defaults to meeting when frontmatter or platform is absent")
    func defaults() throws {
        let plain = try writeMD("# note\nno frontmatter")
        let noPlatform = try writeMD("---\nid: x\ntitle: y\n---\nbody")
        defer {
            try? FileManager.default.removeItem(at: plain)
            try? FileManager.default.removeItem(at: noPlatform)
        }
        #expect(LibraryItemStore.sourceId(for: plain) == "meeting")
        #expect(LibraryItemStore.sourceId(for: noPlatform) == "meeting")
    }
}
```

- [ ] **Step 2: Update `LibraryItem`**

In `mac/Sources/LlmIdeMac/Models/LibraryItem.swift`, DELETE the entire `SourceKind` enum (the `enum SourceKind: String, Codable, CaseIterable { ... }` block and its doc comment) and the `var sourceKind: SourceKind? = nil` property. Add in place of the property:

```swift
    /// For `.meetings` items only: the `InputSource.id` this file belongs to
    /// (from `SourceRegistry`, classified by frontmatter `platform`). Drives
    /// the SOURCES sub-grouping. `nil` for every other category.
    var sourceId: String? = nil
```

- [ ] **Step 3: Update `LibraryItemStore`**

In `mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift`, replace `sourceKind(for:)` (the `nonisolated static func sourceKind(for url: URL) -> LibraryItem.SourceKind`) with a version returning the source id:

```swift
    /// Classify a `source/` file to its `InputSource.id` by reading the
    /// `platform` field from its `.md` frontmatter. Best-effort: reads only the
    /// file head and defaults to the meeting source for non-`.md` files,
    /// missing frontmatter, or an absent `platform` line.
    nonisolated static func sourceId(for url: URL) -> String {
        guard url.pathExtension.lowercased() == "md",
              let handle = try? FileHandle(forReadingFrom: url) else {
            return MeetingSource().id
        }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 2048))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
        guard head.hasPrefix("---") else { return MeetingSource().id }
        for raw in head.split(separator: "\n").dropFirst() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line == "---" { break }
            if line.hasPrefix("platform:") {
                let value = line.dropFirst("platform:".count)
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                return SourceRegistry.source(forPlatform: value).id
            }
        }
        return MeetingSource().id
    }
```

Then in `performScan`, change the meetings-classification line from:
```swift
                if category == .meetings {
                    item.sourceKind = sourceKind(for: fileURL)
                }
```
to:
```swift
                if category == .meetings {
                    item.sourceId = sourceId(for: fileURL)
                }
```

- [ ] **Step 4: Update the Library SOURCES rendering**

In `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift`, replace `sourcesSection(_:)` and `sourceSubGroup(...)` so they iterate the registry instead of `SourceKind`:

Replace `sourcesSection(_:)` with:
```swift
    @ViewBuilder
    private func sourcesSection(_ category: LibraryItem.Category) -> some View {
        let all = itemStore.items(for: category)
        let grouped = Dictionary(grouping: all) { $0.sourceId ?? MeetingSource().id }
        Section {
            if sectionExpanded(sectionId(category)).wrappedValue {
                ForEach(SourceRegistry.all, id: \.id) { source in
                    sourceSubGroup(source: source, items: grouped[source.id] ?? [],
                                   tint: theme.current.tint(for: category))
                }
            }
        } header: {
            sectionHeader(category, count: all.count)
        }
    }
```

Replace `sourceSubGroup(kind:items:tint:)` with a source-driven version:
```swift
    @ViewBuilder
    private func sourceSubGroup(source: InputSource, items: [LibraryItem],
                                tint: Color) -> some View {
        let stateKey = "sources:\(source.id)"
        let isExpanded = Binding(
            get: { !collapsedSourceGroups.contains(stateKey) },
            set: { open in
                if open { collapsedSourceGroups.remove(stateKey) }
                else     { collapsedSourceGroups.insert(stateKey) }
            }
        )
        DisclosureGroup(isExpanded: isExpanded) {
            if items.isEmpty {
                emptyRow(source.emptyText, icon: source.icon, leading: 6)
            } else {
                ForEach(items) { item in
                    LibraryFileRow(item: item)
                        .tag(ShellState.LibrarySelection.file(item.url))
                        .padding(.leading, 6)
                }
                .onDelete { offsets in
                    let toDelete = offsets.map { items[$0] }
                    toDelete.forEach { itemStore.remove(id: $0.id) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: source.icon)
                    .font(Typography.filename)
                    .foregroundStyle(tint)
                Text(source.displayName)
                    .font(Typography.filename)
                    .foregroundStyle(.primary)
                if !items.isEmpty {
                    Text("\(items.count)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.leading, 16)
    }
```

- [ ] **Step 5: Build and resolve any remaining `SourceKind` references**

Run:
```bash
cd /Users/dinesh.malla/llm-ide
grep -rn "SourceKind" mac/Sources mac/Tests
```
Expected: no matches (all migrated). If any remain (e.g. another view referencing `item.sourceKind` or `LibraryItem.SourceKind`), update them to `sourceId` / `SourceRegistry`. Then:
`cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6` → `Build complete!`

- [ ] **Step 6: Commit**

```bash
git rm mac/Tests/LlmIdeMacTests/LibraryItemSourceKindTests.swift
git add mac/Sources/LlmIdeMac/Models/LibraryItem.swift mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift mac/Tests/LlmIdeMacTests/LibraryItemSourceClassificationTests.swift
git commit -m "refactor(mac): retire LibraryItem.SourceKind for registry-driven sourceId" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Final verification + mark spec implemented

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-input-source-abstraction-design.md` (status line)

- [ ] **Step 1: Confirm the abstraction is the single path**

Run:
```bash
cd /Users/dinesh.malla/llm-ide
grep -rn "SourceKind" mac/Sources mac/Tests        # expect: no matches
grep -rn "\.sourceKind\b" mac/Sources               # expect: no matches
grep -rn "platform == \"email\"\|== .email" mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift  # expect: no hardcoded check
```
Expected: no matches for any (classification now flows through `SourceRegistry`).

- [ ] **Step 2: Full build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -4` → `Build complete!`

- [ ] **Step 3: Run the Mac suite (CI / full Xcode)**

On CI / full Xcode: `cd mac && swift test 2>&1 | tail -8` → all pass, incl. `SourceRegistryTests` and `LibraryItemSourceClassificationTests`.

- [ ] **Step 4: Mark spec implemented + commit**

Change the spec's `**Status:**` line to `Implemented 2026-06-23`. Then:
```bash
git add docs/superpowers/specs/2026-06-23-input-source-abstraction-design.md
git commit -m "docs(spec): mark input-source abstraction (Phase 1) implemented" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Runtime verification (user)**

The GUI can't be driven headlessly. In the running app, confirm (behavior must be unchanged):
- Library SOURCES still shows Meetings and Mail sub-groups with the right files and counts; collapse state persists.
- "Fetch now" on the Email card still imports new mail; imported emails appear under Mail.
- A captured meeting still appears under Meetings.

---

## Self-Review

- **Spec coverage:** `InputSource` protocol + `SourceMode` → Task 1; `SourceRegistry` + `MeetingSource`/`EmailSource` (one uniform protocol; live-capture no-op default) → Task 2; email ingest moved + `SourceIngestService` generic driver → Tasks 2–3; retire `SourceKind` → `sourceId` classified via registry, SOURCES display iterates registry → Task 4; Mac-client-only / server untouched / behavior-preserving → honored (no server or `.md`-format changes); tests → Tasks 2 & 4. The three documented refinements (no `testConnection` in protocol, no generic card, keep `InputSourceRegistry` planned list) are called out at the top. ✔
- **Placeholder scan:** none — every code step shows full code; run steps give commands + expected output (with the CI caveat for `swift test`). ✔
- **Type consistency:** `SourceIngestResult` (Task 1) used by `InputSource.fetchAndIngest`, `EmailSource`, and `SourceIngestService` (Tasks 1–3) identically; `SourceContext(api:config:root:notesOutputFolder:)` defined Task 1, constructed in `SourceIngestService.context` Task 3 with the same labels; `SourceRegistry.source(forPlatform:)`/`source(id:)`/`fetchSources`/`all` defined Task 2, used in Tasks 3–4; `LibraryItemStore.sourceId(for:)` defined Task 4 and used by the migrated test; `LibraryItem.sourceId` replaces `sourceKind` consistently across model, store, and view. ✔
