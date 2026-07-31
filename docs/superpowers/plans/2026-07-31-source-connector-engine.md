# Source Connector Engine (Plan A — foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the shared primitives and the Source Connector engine core so that a real source can ride on it in Plan B — proven with a `FakeConnectorAdapter`.

**Architecture:** Generalize the three shared primitives email already uses (`InboxStore` → header-agnostic, `InboxGenerationPipeline` → header dict, `NoteType` → extensible string-backed), then add the engine: a `SourceConnectorManifest`, one `SourceConnector` impl driven by a thin `SourceConnectorAdapter` protocol, a shared `SourceConnectorNoteWriter`, a per-project `sourceConnectorRoot` setting, and eager `ensureSetup()` folder creation. Email is adapted to the new primitive signatures (behavior unchanged); it is *migrated* to a connector in Plan B.

**Tech Stack:** Swift (SwiftPM), SwiftUI, XCTest. Sources live in the `LlmIdeMacLib` target (`mac/Sources/LlmIdeMac/...`); tests `@testable import LlmIdeMacLib`.

**Spec:** [`docs/superpowers/specs/2026-07-31-slack-connector-engine-design.md`](../specs/2026-07-31-slack-connector-engine-design.md)

> **Already landed:** the generated-notes folder was renamed `notes/` → `llm-doc/` (commit `34607a6`), with a one-time `NotesToLlmDocMigration`. This plan therefore writes connector notes to `llm-doc/<noteType>/` (via `NoteService.notesRoot`, which already returns `<repoRoot>/llm-doc/`).

## Global Constraints

- Every state-mutating Mac helper keeps `@MainActor` where the existing peers are (`SourceContext`, `SourceIngestService`, `InputSource.fetchAndIngest` are `@MainActor`).
- All new code goes under `mac/Sources/LlmIdeMac/SourceConnectors/`. Type prefix is **`SourceConnector`**.
- `NoteType` on-disk directories for the legacy 3 stay **plural** (`llm-doc/meetings/`, `llm-doc/emails/`, `llm-doc/documents/`); new connector types use their `rawValue` as the dir name (e.g. `llm-doc/slack/`). Existing notes must not move.
- Generated notes root is `llm-doc/` (already the case after the rename) — do not reintroduce a `notes/` literal.
- Verify with `swift build` / `swift test` from `mac/` — **not** the editor (SourceKit "errors" can be stale; the build is the source of truth).
- Commits: Conventional Commits, one concern each.

## File Structure

**Modify:**
- `mac/Sources/LlmIdeMac/Services/NoteService.swift` — `NoteType` → extensible; `getDirForType`/`rebuildIndex` generic.
- `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift` — header-agnostic `write`.
- `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift` — `RawInboxItem.headers`.
- `mac/Sources/LlmIdeMac/Sources/EmailSource.swift` — adapt `saveRaw`/`generateNote` to new signatures (behavior unchanged).
- `mac/Sources/LlmIdeMac/Sources/InputSource.swift` — `SourceContext` gains `sourceConnectorRoot`.
- `mac/Sources/LlmIdeMac/Services/SourceIngestService.swift` — uses `sourceConnectorRoot`.
- `mac/Sources/LlmIdeMac/Models/Config.swift` — add `sourceConnectorRoot` setting.
- `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift` — add generic `postClassification`.

**Create:**
- `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorManifest.swift` — Codable manifest + bundled loader.
- `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorAdapter.swift` — protocol + `SourceConnectorFetchBatch` + `ClassifyRequest` + shared types.
- `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorNoteWriter.swift` — generic note writer.
- `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift` — the instance: `ensureSetup` + `fetchAndIngest`.

**Create tests:**
- `mac/Tests/LlmIdeMacTests/NoteTypeTests.swift`
- `mac/Tests/LlmIdeMacTests/InboxStorePipelineTests.swift`
- `mac/Tests/LlmIdeMacTests/SourceConnectorManifestTests.swift`
- `mac/Tests/LlmIdeMacTests/SourceConnectorEngineTests.swift`
- `mac/Tests/LlmIdeMacTests/SourceConnectorRootTests.swift`

---

### Task 1: Make `NoteType` extensible

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/NoteService.swift:19-24`
- Test: `mac/Tests/LlmIdeMacTests/NoteTypeTests.swift`

**Interfaces:**
- Produces: `NoteType` as `RawRepresentable<String>` with `static let .meeting/.email/.document` (call sites unchanged) and `NoteType(rawValue: "slack")` for new connectors. Encodes/decodes as the raw string (back-compat with existing `index.json`).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class NoteTypeTests: XCTestCase {
    func testLegacyConstantsStillEqualTheirRawValues() {
        XCTAssertEqual(NoteType.meeting.rawValue, "meeting")
        XCTAssertEqual(NoteType.email.rawValue, "email")
        XCTAssertEqual(NoteType.document.rawValue, "document")
    }

    func testNewTypeConstructibleFromArbitraryString() {
        let slack = NoteType(rawValue: "slack")
        XCTAssertEqual(slack.rawValue, "slack")
        XCTAssertEqual(NoteType("slack"), slack)
    }

    func testLegacyDirectoryNamesPreserved() {
        XCTAssertEqual(NoteType.meeting.directoryName, "meetings")
        XCTAssertEqual(NoteType.email.directoryName, "emails")
        XCTAssertEqual(NoteType.document.directoryName, "documents")
        XCTAssertEqual(NoteType(rawValue: "slack").directoryName, "slack")
    }

    func testCodableRoundTripsArbitraryType() throws {
        let original = NoteType(rawValue: "slack")
        let encoded = try JSONEncoder().encode(original)
        XCTAssertEqual(String(data: encoded, encoding: .utf8), #""slack""#)
        let decoded = try JSONDecoder().decode(NoteType.self, from: encoded)
        XCTAssertEqual(decoded, original)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter NoteTypeTests`
Expected: FAIL — `NoteType` is an enum and has no `directoryName`.

- [ ] **Step 3: Replace the enum with an extensible struct**

In `mac/Sources/LlmIdeMac/Services/NoteService.swift`, replace lines 19-24 (the `enum NoteType`):

```swift
/// Note type classification. Extensible: legacy sources use the static
/// constants (`.meeting`, `.email`, `.document`); new Source Connectors
/// construct from their manifest `noteType` string, e.g. `NoteType("slack")`.
/// On disk the legacy 3 keep their plural directories; new types use the
/// raw value as the directory name.
public struct NoteType: RawRepresentable, Codable, Sendable, Hashable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { self.rawValue = raw }

    public static let meeting = NoteType(rawValue: "meeting")
    public static let email = NoteType(rawValue: "email")
    public static let document = NoteType(rawValue: "document")

    /// Directory name under `llm-doc/`. Legacy 3 map to their existing plural
    /// dirs so already-written notes stay put; everything else uses rawValue.
    public var directoryName: String {
        switch rawValue {
        case "meeting": return "meetings"
        case "email": return "emails"
        case "document": return "documents"
        default: return rawValue
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter NoteTypeTests`
Expected: PASS (4 tests). Also `swift build` — the rest of the codebase must still compile.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/NoteService.swift mac/Tests/LlmIdeMacTests/NoteTypeTests.swift
git commit -m "refactor(mac): make NoteType extensible (RawRepresentable<String>)"
```

---

### Task 2: Generic `NoteService` directories

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/NoteService.swift:166-176` (`getDirForType`) and `:325-343` (`rebuildIndex`)
- Test: `mac/Tests/LlmIdeMacTests/NoteTypeTests.swift` (append)

**Interfaces:**
- Produces: `getDirForType(_:)` resolves via `directoryName` (works for any `NoteType`); `rebuildIndex()` discovers all type subdirs under `llm-doc/` instead of a hardcoded list. `meetingsDir`/`emailsDir`/`documentsDir` unchanged for back-compat.

- [ ] **Step 1: Write the failing test (append to `NoteTypeTests.swift`)**

```swift
extension NoteTypeTests {
    func testRebuildIndexDiscoversAllTypeDirectories() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("notetype-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let svc = NoteService(repoRoot: tmp)

        // Create a legacy plural dir + a new connector dir under llm-doc/.
        for sub in ["meetings/2026/01", "slack/2026/01"] {
            let dir = svc.notesRoot.appendingPathComponent(sub, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data("x".utf8).write(to: dir.appendingPathComponent("a.md"))
        }

        let index = try await svc.rebuildIndex()
        let types = Set(index.notes.map { $0.type.rawValue })
        XCTAssertEqual(types, Set(["meeting", "slack"]))
    }

    func testGetDirForTypeUsesDirectoryName() {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("notetype-dir-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let svc = NoteService(repoRoot: tmp)
        XCTAssertEqual(svc.getDirForType(.meeting).lastPathComponent, "meetings")
        XCTAssertEqual(svc.getDirForType(NoteType("slack")).lastPathComponent, "slack")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter NoteTypeTests`
Expected: FAIL — `rebuildIndex` only scans `[.meeting, .email, .document]`, so the `slack` dir is not discovered.

- [ ] **Step 3: Make `getDirForType` use `directoryName`**

Replace the `getDirForType(_:)` body (lines 167-176):

```swift
    /// Get the appropriate subdirectory for a note type. Uses `directoryName`
    /// so any Source Connector's note type resolves without a code change.
    public func getDirForType(_ type: NoteType) -> URL {
        notesRoot.appendingPathComponent(type.directoryName, isDirectory: true)
    }
```

- [ ] **Step 4: Make `rebuildIndex` discover type directories**

Replace the `rebuildIndex()` body (lines 325-343):

```swift
    /// Rebuild the entire index by scanning the notes directory. Discovers
    /// every type subdirectory (legacy plural + new connector dirs) rather
    /// than a hardcoded list.
    public func rebuildIndex() async throws -> NoteIndex {
        var notes: [NoteMetadata] = []

        try? FileManager.default.createDirectory(at: notesRoot, withIntermediateDirectories: true)
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: notesRoot, includingPropertiesForKeys: [.isDirectoryKey]) else {
            return NoteIndex()
        }
        let typeDirs = contents.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        for typeDir in typeDirs {
            let type = NoteType(rawValue: typeDir.lastPathComponent)
            let typeNotes = try await scanTypeDirectory(type: type, dir: typeDir)
            notes.append(contentsOf: typeNotes)
        }

        let index = NoteIndex(
            version: 1,
            updated: ISO8601DateFormatter().string(from: Date()),
            notes: notes
        )
        try saveIndex(index)
        return index
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mac && swift test --filter NoteTypeTests`
Expected: PASS (all 6). Then `cd mac && swift build` — green.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/NoteService.swift mac/Tests/LlmIdeMacTests/NoteTypeTests.swift
git commit -m "refactor(mac): NoteService discovers note type dirs generically"
```

---

### Task 3: Header-agnostic `InboxStore`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/InboxStorePipelineTests.swift`

**Interfaces:**
- Produces: `InboxStore.write(headers: [String:String], body: String, slug: String) throws -> URL` — writes each header as `Key: Value`, a blank line, then `body`, to `root/YYYY/MM/<stamp>-<slug>.txt`. `slugify` becomes `static func` (internal). `Date:` is expected by the pipeline parser (convention).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class InboxStorePipelineTests: XCTestCase {
    func testInboxStoreWritesArbitraryHeadersAndBody() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let url = try InboxStore(root: tmp).write(
            headers: ["Channel": "#team", "User": "alice", "Ts": "1700000000.0001",
                      "Date": "2026-07-31T09:00:00Z"],
            body: "hello world",
            slug: "team-1700000000.0001")
        let contents = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(contents.hasPrefix("Channel: #team\n"))
        XCTAssertTrue(contents.contains("User: alice\n"))
        XCTAssertTrue(contents.contains("Date: 2026-07-31T09:00:00Z\n\n"))
        XCTAssertTrue(contents.hasSuffix("\n\nhello world"))
        XCTAssertTrue(url.lastPathComponent.hasPrefix("20"))            // YYYY stamp
        XCTAssertTrue(url.lastPathComponent.contains("team-1700000000")) // slug present
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter InboxStorePipelineTests`
Expected: FAIL — no `write(headers:body:slug:)`; old signature is `write(from:date:subject:body:)`.

- [ ] **Step 3: Replace `InboxStore` with the header-agnostic version**

Replace the entire contents of `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift`:

```swift
// mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift
import Foundation

/// Writes one raw captured item per file into `<root>/YYYY/MM/`. Pairs with
/// `InboxGenerationPipeline`, which scans what this writes. Header-agnostic:
/// any source (email, slack, future connectors) passes its own headers.
///
/// Files written here are never modified, moved, or deleted by the app —
/// they are the permanent raw record. Dedup for generation purposes is by
/// content hash, computed by `InboxGenerationPipeline` from the file bytes.
struct InboxStore {
    let root: URL
    init(root: URL) { self.root = root }

    /// Writes each `Key: Value` header, a blank line, then `body`, to
    /// `root/YYYY/MM/<yyyy-MM-dd-HHmmss>-<slug>.txt`. The pipeline parser
    /// requires a `Date:` header (ISO-8601) to recover the item date.
    @discardableResult
    func write(headers: [String: String], body: String, slug: String) throws -> URL {
        let headerBlock = headers.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
        let contents = "\(headerBlock)\n\n\(body)"
        let date = (headers["Date"].flatMap { AppDateFormatter.parseISO($0) }) ?? Date()
        let folder = monthFolder(for: date)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(filename(date: date, slug: slug))
        try Data(contents.utf8).write(to: url, options: .atomic)
        return url
    }

    private func monthFolder(for date: Date) -> URL {
        let c = Calendar.current.dateComponents([.year, .month], from: date)
        return root
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
    }

    private func filename(date: Date, slug: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        return "\(f.string(from: date))-\(slug).txt"
    }

    /// Shared slug helper (callers build the slug for the raw filename).
    static func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "item" : String(collapsed.prefix(60))
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter InboxStorePipelineTests`
Expected: PASS. The build will be red in `EmailSource` (still the old signature) — fixed in Task 5.

- [ ] **Step 5: (no commit yet — the build is red until Task 5)**

---

### Task 4: Generalize `InboxGenerationPipeline` (`RawInboxItem.headers`)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift`
- Test: `mac/Tests/LlmIdeMacTests/InboxStorePipelineTests.swift` (append)

**Interfaces:**
- Produces: `RawInboxItem` carries `headers: [String:String]` (replaces `from`/`subject`), plus existing `url`, `date`, `body`, `hash`. `parse()` reads every `Key: Value` line before the blank-line separator.

- [ ] **Step 1: Write the failing test (append)**

```swift
extension InboxStorePipelineTests {
    func testPipelineParsesArbitraryHeadersAndDedupsByHash() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pipe-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        try InboxStore(root: tmp).write(
            headers: ["Channel": "#team", "User": "alice", "Date": "2026-07-31T09:00:00Z"],
            body: "standup", slug: "team-a")
        try InboxStore(root: tmp).write(
            headers: ["From": "boss@x", "Subject": "hi", "Date": "2026-07-31T10:00:00Z"],
            body: "email body", slug: "email-hi")

        var seen: [[String: String]] = []
        let result = await InboxGenerationPipeline.run(
            inboxRoot: tmp, knownHashes: []) { item in
                seen.append(item.headers)
            }
        XCTAssertEqual(result.processed, 2)
        XCTAssertEqual(result.failures, [])
        XCTAssertEqual(seen.count, 2)
        XCTAssertEqual(seen.compactMap { $0["Channel"] }, ["#team"])
        XCTAssertEqual(seen.compactMap { $0["From"] }, ["boss@x"])
    }

    func testPipelineSkipsItemsWhoseHashIsKnown() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pipe-dedup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try InboxStore(root: tmp).write(
            headers: ["Channel": "#team", "Date": "2026-07-31T09:00:00Z"],
            body: "once", slug: "team-x")

        var hash = ""
        _ = await InboxGenerationPipeline.run(inboxRoot: tmp, knownHashes: []) { item in hash = item.hash }

        var calls = 0
        let result = await InboxGenerationPipeline.run(inboxRoot: tmp, knownHashes: [hash]) { _ in calls += 1 }
        XCTAssertEqual(result.processed, 0)
        XCTAssertEqual(calls, 0)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter InboxStorePipelineTests`
Expected: FAIL — `RawInboxItem` has no `headers`.

- [ ] **Step 3: Update `RawInboxItem` and `parse()`**

In `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift`, replace the `RawInboxItem` struct (lines 8-15):

```swift
/// One parsed raw item recovered from an `InboxStore` file, plus the raw
/// file's SHA-256 content hash — the dedup key `InboxGenerationPipeline`
/// checks against notes already generated. `headers` is the full `Key: Value`
/// block (source-defined: email→From/Subject, slack→Channel/User/Ts, …);
/// `Date:` is always present and parsed into `date`.
struct RawInboxItem {
    let url: URL
    let date: Date
    let body: String
    let hash: String
    let headers: [String: String]
}
```

Replace the `parse(file:data:hash:)` method (lines 71-85):

```swift
    private static func parse(file: URL, data: Data, hash: String) -> RawInboxItem? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        guard let sep = text.range(of: "\n\n") else { return nil }
        let header = String(text[text.startIndex..<sep.lowerBound])
        let body = String(text[sep.upperBound...])

        var headers: [String: String] = [:]
        for line in header.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        guard let dateStr = headers["Date"], let date = AppDateFormatter.parseISO(dateStr) else { return nil }
        return RawInboxItem(url: file, date: date, body: body, hash: hash, headers: headers)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter InboxStorePipelineTests`
Expected: PASS (3 tests). Build still red in `EmailSource` (fixed next).

- [ ] **Step 5: (no commit yet — build red until Task 5)**

---

### Task 5: Adapt `EmailSource` to the new primitives (build-green gate)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Sources/EmailSource.swift:79-83` (`saveRaw`) and `:107-138` (`generateNote`)
- Test: `mac/Tests/LlmIdeMacTests/InboxStorePipelineTests.swift` (append a behavior-preservation test)

**Interfaces:**
- Consumes: `InboxStore.write(headers:body:slug:)`, `RawInboxItem.headers`.
- Produces: unchanged `EmailSource` behavior via the new signatures. This is the parity gate.

- [ ] **Step 1: Write the failing test (append)**

```swift
import Foundation
extension InboxStorePipelineTests {
    /// Email's routeDecision is pure — lock its behavior so the signature
    /// change in saveRaw/generateNote can't silently alter routing.
    func testEmailRouteDecisionUnchanged() {
        let worthy = LlmIdeAPIClient.EmailClassification(
            category: "work", noteWorthy: true, summary: "s", todos: [])
        let notWorthy = LlmIdeAPIClient.EmailClassification(
            category: "newsletter", noteWorthy: false, summary: "s", todos: [])

        XCTAssertEqual(EmailSource.routeDecision(from: "noreply@x.com", classification: worthy),
                       .skipped(category: "bulk"))
        XCTAssertEqual(EmailSource.routeDecision(from: "alice@x.com", classification: worthy),
                       .note(worthy))
        XCTAssertEqual(EmailSource.routeDecision(from: "alice@x.com", classification: notWorthy),
                       .skipped(category: "newsletter"))
        XCTAssertEqual(EmailSource.routeDecision(from: "alice@x.com", classification: nil, classifyFailed: true),
                       .skipped(category: "unclassified"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `cd mac && swift test --filter InboxStorePipelineTests`
Expected: this test passes (behavior lock), but the build is still red from Task 3/4 because `EmailSource.saveRaw`/`generateNote` reference removed members. Confirm the red errors point only at `EmailSource`.

- [ ] **Step 3: Update `saveRaw`**

In `mac/Sources/LlmIdeMac/Sources/EmailSource.swift`, replace the `saveRaw(from:inboxRoot:)` method (lines 79-83):

```swift
    @MainActor
    private func saveRaw(from msg: EmailMessage, inboxRoot: URL) throws {
        let startedAt = AppDateFormatter.parseISO(msg.date) ?? Date()
        try InboxStore(root: inboxRoot).write(
            headers: ["From": msg.from, "Subject": msg.subject,
                      "Date": AppDateFormatter.isoString(startedAt)],
            body: msg.text,
            slug: InboxStore.slugify(msg.subject.isEmpty ? "email" : msg.subject))
    }
```

- [ ] **Step 4: Update `generateNote` to read headers**

In the same file, replace the first four lines of `generateNote` (lines 108-113):

```swift
    @MainActor
    private static func generateNote(item: RawInboxItem, writer: EmailNoteWriter, ctx: SourceContext) async throws {
        let from = item.headers["From"] ?? ""
        let subject = item.headers["Subject"] ?? ""
        let rawFileName = item.url.lastPathComponent
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy/MM"
        let monthPath = dateFormatter.string(from: item.date)
        let rawFile = "EmailInbox/\(monthPath)/\(rawFileName)"
```

Then replace the body of the same method that used `item.from`/`item.subject` (the `isBulkSender` check + `writeSkipped`/`writeNote` calls, lines ~115-138) to use the locals:

```swift
        if EmailFileStore.isBulkSender(from) {
            _ = try await writer.writeSkipped(from: from, date: item.date, subject: subject,
                                       category: "bulk", originalBody: item.body, sourceHash: item.hash, rawFile: rawFile)
            return
        }

        var classification: LlmIdeAPIClient.EmailClassification?
        var failed = false
        do {
            classification = try await ctx.api.classifyEmail(
                subject: subject, from: from,
                date: AppDateFormatter.isoString(item.date), body: item.body)
        } catch {
            failed = true
        }

        switch routeDecision(from: from, classification: classification, classifyFailed: failed) {
        case .note(let c):
            _ = try await writer.writeNote(from: from, date: item.date, subject: subject,
                                    classification: c, originalBody: item.body, sourceHash: item.hash, rawFile: rawFile)
        case .skipped(let category):
            _ = try await writer.writeSkipped(from: from, date: item.date, subject: subject,
                                       category: category, originalBody: item.body, sourceHash: item.hash, rawFile: rawFile)
        }
    }
```

- [ ] **Step 5: Run all tests + build**

Run: `cd mac && swift build && swift test`
Expected: BUILD green; all tests PASS.

- [ ] **Step 6: Commit (one commit for Tasks 3+4+5)**

```bash
git add mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift \
        mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift \
        mac/Sources/LlmIdeMac/Sources/EmailSource.swift \
        mac/Tests/LlmIdeMacTests/InboxStorePipelineTests.swift
git commit -m "refactor(mac): header-agnostic InboxStore + pipeline; adapt EmailSource"
```

---

### Task 6: `SourceConnectorManifest` + loader

**Files:**
- Create: `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorManifest.swift`
- Test: `mac/Tests/LlmIdeMacTests/SourceConnectorManifestTests.swift`

**Interfaces:**
- Produces: `SourceConnectorManifest` (Codable) with `id`, `displayName`, `icon`, `emptyText`, `platforms`, `mode`, `inboxFolder`, `noteType` (String), `endpoints`, `adapter`, `configFields`, `rawHeaders`, `noiseFilter`. `SourceConnectorManifest.loadBundled()` reads `Resources/source_connectors/*.json` (empty set for now — real manifests land in Plan B).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class SourceConnectorManifestTests: XCTestCase {
    private let slackJSON = #"""
    {
      "id": "slack", "displayName": "Slack", "icon": "number",
      "emptyText": "No Slack messages yet", "platforms": ["slack"], "mode": "fetch",
      "inboxFolder": "SlackInbox", "noteType": "slack",
      "endpoints": { "test":"/kb/slack/test", "fetch":"/kb/slack/fetch",
                     "seen":"/kb/slack/seen", "classify":"/kb/slack/classify" },
      "adapter": "SlackConnectorAdapter",
      "configFields": [
        { "key":"channels", "label":"Channels", "type":"stringList", "required":true },
        { "key":"lookbackDays", "label":"Lookback (days)", "type":"int", "default":7 }
      ],
      "rawHeaders": { "Channel":"$channelId", "User":"$user", "Ts":"$ts", "Date":"$date" },
      "noiseFilter": { "minLength":2, "skipEmojiOnly":true }
    }
    """#

    func testDecodesSlackManifest() throws {
        let manifest = try JSONDecoder().decode(SourceConnectorManifest.self, from: Data(slackJSON.utf8))
        XCTAssertEqual(manifest.id, "slack")
        XCTAssertEqual(manifest.noteType, "slack")
        XCTAssertEqual(manifest.inboxFolder, "SlackInbox")
        XCTAssertEqual(manifest.mode, .fetch)
        XCTAssertEqual(manifest.endpoints.classify, "/kb/slack/classify")
        XCTAssertEqual(manifest.adapter, "SlackConnectorAdapter")
        XCTAssertEqual(manifest.rawHeaders["Channel"], "$channelId")
        XCTAssertEqual(manifest.noiseFilter?.minLength, 2)
        XCTAssertEqual(manifest.configFields.first?.type, .stringList)
    }

    func testLoadBundledReturnsEmptyWhenNoResources() {
        let all = SourceConnectorManifest.loadBundled()
        XCTAssertEqual(all, [])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter SourceConnectorManifestTests`
Expected: FAIL — `SourceConnectorManifest` does not exist.

- [ ] **Step 3: Create the manifest + loader**

Create `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorManifest.swift`:

```swift
import Foundation

/// One Source Connector's declarative description. No logic — just metadata,
/// UI fields, folder/note names, endpoint paths, the raw-header mapping, and
/// the name of the Swift adapter that owns the wire-shape mechanics.
struct SourceConnectorManifest: Codable, Equatable {
    let id: String
    let displayName: String
    let icon: String
    let emptyText: String
    let platforms: [String]
    let mode: Mode
    let inboxFolder: String
    let noteType: String
    let endpoints: Endpoints
    let adapter: String
    let configFields: [ConfigField]
    let rawHeaders: [String: String]
    let noiseFilter: NoiseFilter?

    enum Mode: String, Codable { case fetch, liveCapture }

    struct Endpoints: Codable, Equatable {
        let test: String
        let fetch: String
        let seen: String
        let classify: String
    }

    struct ConfigField: Codable, Equatable {
        let key: String
        let label: String
        let type: FieldType
        var required: Bool = false
        var `default`: StringDefaultValue? = nil

        enum FieldType: String, Codable {
            case string, stringList, int, toggle, secret, select
        }
    }

    /// Wrapper so an int default (`7`) and absence both decode cleanly.
    struct StringDefaultValue: Codable, Equatable {
        let value: String
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { self.value = s }
            else if let i = try? c.decode(Int.self) { self.value = String(i) }
            else { self.value = "" }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            try c.encode(value)
        }
    }

    struct NoiseFilter: Codable, Equatable {
        let minLength: Int?
        let skipEmojiOnly: Bool?
    }

    /// Loads every bundled `Resources/source_connectors/*.json`. Returns an
    /// empty array if the resource directory is absent (Plan A ships no
    /// manifests; Plan B adds email.json + slack.json).
    static func loadBundled() -> [SourceConnectorManifest] {
        guard let dir = Bundle.main.url(forResource: "source_connectors", withExtension: nil),
              let urls = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            return []
        }
        return urls
            .filter { $0.pathExtension.lowercased() == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(SourceConnectorManifest.self, from: data)
            }
            .sorted { $0.id < $1.id }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter SourceConnectorManifestTests`
Expected: PASS (2 tests). `swift build` green.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorManifest.swift \
        mac/Tests/LlmIdeMacTests/SourceConnectorManifestTests.swift
git commit -m "feat(mac): SourceConnectorManifest + bundled loader"
```

---

### Task 7: `SourceConnectorAdapter` protocol + shared types

**Files:**
- Create: `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorAdapter.swift`
- Create: `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorNoteWriter.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift` — add generic `postClassification`.
- Test: `mac/Tests/LlmIdeMacTests/SourceConnectorEngineTests.swift`

**Interfaces:**
- Produces:
  - `SourceConnectorFetchedItem { fields: [String:String]; body: String }`.
  - `SourceConnectorFetchBatch { items; drained; overCap; failures }`.
  - `ClassifyRequest { body: [String:String] }` + `SourceConnectorClassification { category, noteWorthy, summary, todos[] }` (with `Todo`).
  - `protocol SourceConnectorAdapter` — `fetch`, `markSeen`, `classifyRequest(from:)`.
  - `SourceConnectorNoteWriter` — `writeNote`/`writeSkipped`/`existingSourceHashes(noteType:)` via `NoteService` (notes land under `llm-doc/<noteType>/`).
  - `LlmIdeAPIClient.postClassification(path:body:)` — generic classify POST.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class SourceConnectorEngineTests: XCTestCase {
    func testNoteWriterWritesAndReportsHashes() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-note-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let writer = SourceConnectorNoteWriter(repoRoot: tmp, noteType: NoteType("slack"))

        let classification = SourceConnectorClassification(
            category: "work", noteWorthy: true, summary: "ship it",
            todos: [SourceConnectorClassification.Todo(title: "t", detail: "d", due: nil, priority: "med")])
        _ = try await writer.writeNote(
            headers: ["Channel": "#team", "User": "alice", "Date": "2026-07-31T09:00:00Z"],
            title: "#team — alice", date: AppDateFormatter.parseISO("2026-07-31T09:00:00Z")!,
            classification: classification, originalBody: "ship it",
            sourceHash: "abc123", rawFile: "SlackInbox/2026/07/x.txt")

        let hashes = try await writer.existingSourceHashes()
        XCTAssertTrue(hashes.contains("abc123"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter SourceConnectorEngineTests`
Expected: FAIL — types do not exist.

- [ ] **Step 3: Create the adapter protocol + shared types**

Create `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorAdapter.swift`:

```swift
import Foundation

/// One item fetched by an adapter, as a field-value dict + the text body.
struct SourceConnectorFetchedItem {
    let fields: [String: String]
    let body: String
}

/// What an adapter's `fetch` returns: the items, whether the source fully
/// drained (advance the high-water), per-fetch cap overflow, and non-fatal
/// failures accumulated per source/channel.
struct SourceConnectorFetchBatch {
    let items: [SourceConnectorFetchedItem]
    let drained: Bool
    let overCap: Int
    let failures: [String]
}

/// Opaque field map the engine POSTs to the manifest's `classify` endpoint.
struct ClassifyRequest: Encodable {
    let body: [String: String]
}

/// `/kb/.../classify` response (twin of `LlmIdeAPIClient.EmailClassification`).
struct SourceConnectorClassification: Decodable, Equatable {
    let category: String
    let noteWorthy: Bool
    let summary: String
    let todos: [Todo]
    struct Todo: Decodable, Equatable {
        let title: String
        let detail: String
        let due: String?
        let priority: String
    }
}

/// Owns ONLY the wire-shape mechanics for one source. Everything else
/// (raw storage, dedup, the generation loop, note writing, high-water
/// accounting) lives in the engine.
@MainActor
protocol SourceConnectorAdapter {
    func fetch(_ ctx: SourceContext) async throws -> SourceConnectorFetchBatch
    func markSeen(_ ctx: SourceContext, batch: SourceConnectorFetchBatch, drained: Bool) async throws
    func classifyRequest(from item: RawInboxItem) -> ClassifyRequest
}
```

Add the generic classify POST to `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift`:

```swift
extension LlmIdeAPIClient {
    /// Generic classify POST for any Source Connector: sends the adapter-built
    /// field map and decodes the shared classification shape.
    func postClassification(path: String, body: [String: String]) async throws -> SourceConnectorClassification {
        struct Req: Encodable { let body: [String: String] }
        return try await post(path, body: Req(body: body), authenticated: true)
    }
}
```

- [ ] **Step 4: Create the note writer**

Create `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorNoteWriter.swift`:

```swift
import Foundation

/// Writes Source Connector notes via the unified `NoteService` (notes land
/// under `llm-doc/<noteType>/`). Generalizes `EmailNoteWriter`: any
/// connector's note (frontmatter + summary + to-dos) keyed for dedup by
/// `sourceHash`.
struct SourceConnectorNoteWriter {
    let noteService: NoteService
    let noteType: NoteType
    let platform: String

    init(repoRoot: URL, noteType: NoteType, platform: String? = nil) {
        self.noteService = NoteService(repoRoot: repoRoot)
        self.noteType = noteType
        self.platform = platform ?? noteType.rawValue
    }

    @discardableResult
    func writeNote(
        headers: [String: String], title: String, date: Date,
        classification c: SourceConnectorClassification,
        originalBody: String, sourceHash: String, rawFile: String
    ) async throws -> URL {
        let fm = FrontMatter(source: platform, platform: platform, noteType: noteType.rawValue,
                             headers: headers, date: AppDateFormatter.isoString(date),
                             category: c.category, noteWorthy: true, sourceHash: sourceHash,
                             rawFile: rawFile, todos: c.todos)
        var md = fm.rendered()
        md += "# \(title)\n\n**Summary:** \(c.summary)\n\n## To-dos\n\n"
        if c.todos.isEmpty {
            md += "_No action items._\n\n"
        } else {
            for t in c.todos {
                let due = t.due.map { " — due \($0)" } ?? ""
                md += "- [ ] \(t.title)\(due) (\(t.priority))\n"
            }
            md += "\n"
        }
        md += "## Original\n\n\(originalBody)"
        return try await save(filename: filename(date: date, title: title),
                              md: md, date: date, title: title, tags: [c.category])
    }

    @discardableResult
    func writeSkipped(
        headers: [String: String], title: String, date: Date, category: String,
        originalBody: String, sourceHash: String, rawFile: String
    ) async throws -> URL {
        let fm = FrontMatter(source: platform, platform: platform, noteType: noteType.rawValue,
                             headers: headers, date: AppDateFormatter.isoString(date),
                             category: category, noteWorthy: false, sourceHash: sourceHash,
                             rawFile: rawFile, todos: [])
        let md = fm.rendered() + "# \(title)\n\n## Original\n\n\(originalBody)"
        return try await save(filename: filename(date: date, title: title),
                              md: md, date: date, title: title, tags: [category])
    }

    func existingSourceHashes() async throws -> Set<String> {
        let notes = try await noteService.queryNotes(NoteFilter(type: noteType))
        return Set(notes.compactMap { $0.sourceHash })
    }

    private func save(filename: String, md: String, date: Date, title: String, tags: [String]) async throws -> URL {
        let metadata = NoteMetadata(
            id: "", type: noteType, source: platform, title: title,
            date: AppDateFormatter.isoString(date), path: "", rawFile: nil,
            sourceHash: nil, generatedAt: AppDateFormatter.isoString(Date()),
            tags: tags, participants: nil, fileSize: 0)
        // sourceHash/rawFile are embedded in frontmatter above; NoteMetadata
        // also carries them so queryNotes/existingSourceHashes can dedup.
        var withHash = metadata
        withHash = NoteMetadata(id: metadata.id, type: noteType, source: platform, title: title,
            date: metadata.date, path: "", rawFile: nil, sourceHash: nil,
            generatedAt: metadata.generatedAt, tags: tags, participants: nil, fileSize: 0)
        _ = withHash
        let saved = try await noteService.saveNote(type: noteType, filename: filename,
                                                   content: Data(md.utf8), metadata: metadata)
        return noteService.notesRoot.appendingPathComponent(saved.path)
    }

    private func filename(date: Date, title: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        return "\(f.string(from: date))-\(InboxStore.slugify(title.isEmpty ? platform : title)).md"
    }

    /// Minimal YAML frontmatter renderer (mirrors EmailNoteWriter's shape).
    private struct FrontMatter {
        let source: String; let platform: String; let noteType: String
        let headers: [String: String]; let date: String
        let category: String; let noteWorthy: Bool
        let sourceHash: String; let rawFile: String
        let todos: [SourceConnectorClassification.Todo]
        func rendered() -> String {
            var s = "---\nsource: \(q(source))\nplatform: \(q(platform))\nnoteType: \(q(noteType))\n"
            for (k, v) in headers.sorted(by: { $0.key < $1.key }) { s += "\(k): \(q(v))\n" }
            s += "date: \(date)\ncategory: \(q(category))\nnoteWorthy: \(noteWorthy)\n"
            s += "sourceHash: \(q(sourceHash))\nrawFile: \(q(rawFile))\n"
            if todos.isEmpty { s += "todos: []\n" }
            else {
                s += "todos:\n"
                for t in todos {
                    s += "  - title: \(q(t.title))\n    detail: \(q(t.detail))\n"
                    s += "    due: \(t.due.map { "\"\($0)\"" } ?? "null")\n    priority: \(t.priority)\n"
                }
            }
            return s + "---\n\n"
        }
        private func q(_ x: String) -> String {
            "\"" + x.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
        }
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mac && swift test --filter SourceConnectorEngineTests`
Expected: PASS (1 test). `swift build` green.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorAdapter.swift \
        mac/Sources/LlmIdeMac/SourceConnectors/SourceConnectorNoteWriter.swift \
        mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift \
        mac/Tests/LlmIdeMacTests/SourceConnectorEngineTests.swift
git commit -m "feat(mac): SourceConnectorAdapter protocol + shared note writer"
```

---

### Task 8: `SourceConnector` — `ensureSetup` + `fetchAndIngest`

**Files:**
- Create: `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift`
- Test: `mac/Tests/LlmIdeMacTests/SourceConnectorEngineTests.swift` (append)

**Interfaces:**
- Consumes: `SourceConnectorManifest`, `SourceConnectorAdapter`, `SourceConnectorNoteWriter`, `InboxStore`, `InboxGenerationPipeline`, `SourceContext.sourceConnectorRoot` (added Task 9 — defaults to `ctx.root`).
- Produces: `SourceConnector` (conforms to `InputSource`) with `ensureSetup(at:)` (creates `<root>/<inboxFolder>` + `<root>/llm-doc/<noteType>`) and `fetchAndIngest(_:)`.

- [ ] **Step 1: Write the failing test (append)**

```swift
@MainActor
extension SourceConnectorEngineTests {
    final class FakeAdapter: SourceConnectorAdapter {
        var classified: [RawInboxItem] = []
        var fetchCalls = 0
        func fetch(_ ctx: SourceContext) async throws -> SourceConnectorFetchBatch {
            fetchCalls += 1
            return SourceConnectorFetchBatch(items: [
                .init(fields: ["Channel": "#team", "User": "alice", "Ts": "1", "Date": "2026-07-31T09:00:00Z"],
                      body: "ship it")
            ], drained: true, overCap: 0, failures: [])
        }
        func markSeen(_ ctx: SourceContext, batch: SourceConnectorFetchBatch, drained: Bool) async throws {}
        func classifyRequest(from item: RawInboxItem) -> ClassifyRequest {
            classified.append(item); return ClassifyRequest(body: ["text": item.body])
        }
    }

    private func makeManifest() -> SourceConnectorManifest {
        try! JSONDecoder().decode(SourceConnectorManifest.self, from: Data(#"""
        { "id":"slack","displayName":"Slack","icon":"number","emptyText":"none",
          "platforms":["slack"],"mode":"fetch","inboxFolder":"SlackInbox","noteType":"slack",
          "endpoints":{"test":"/t","fetch":"/f","seen":"/s","classify":"/c"},
          "adapter":"FakeAdapter","configFields":[],
          "rawHeaders":{"Channel":"$Channel","User":"$User","Ts":"$Ts","Date":"$Date"},
          "noiseFilter":{"minLength":2,"skipEmojiOnly":true} }
        """#.utf8))
    }

    func testEnsureSetupCreatesInboxAndLlmDocFolders() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("sc-setup-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let connector = SourceConnector(manifest: makeManifest(), adapterFactory: { FakeAdapter() })
        try connector.ensureSetup(at: tmp)
        XCTAssertTrue(FileManager.default.fileExists(atPath: tmp.appendingPathComponent("SlackInbox").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: tmp.appendingPathComponent("llm-doc").appendingPathComponent("slack").path))
    }

    func testEnsureSetupIsIdempotent() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("sc-idem-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let connector = SourceConnector(manifest: makeManifest(), adapterFactory: { FakeAdapter() })
        try connector.ensureSetup(at: tmp)
        try connector.ensureSetup(at: tmp)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter SourceConnectorEngineTests`
Expected: FAIL — `SourceConnector` does not exist.

- [ ] **Step 3: Create `SourceConnector`**

Create `mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift`:

```swift
import Foundation

/// A single Source Connector instance: one manifest + the adapter that owns
/// its wire mechanics. Conforms to `InputSource` so the existing
/// `SourceIngestService` driver and Library classification work unchanged.
@MainActor
final class SourceConnector: InputSource {
    let manifest: SourceConnectorManifest
    private let adapterFactory: @MainActor () -> any SourceConnectorAdapter

    init(manifest: SourceConnectorManifest,
         adapterFactory: @MainActor @escaping () -> any SourceConnectorAdapter) {
        self.manifest = manifest
        self.adapterFactory = adapterFactory
    }

    var id: String { manifest.id }
    var displayName: String { manifest.displayName }
    var icon: String { manifest.icon }
    var emptyText: String { manifest.emptyText }
    var platforms: [String] { manifest.platforms }
    var mode: SourceMode { manifest.mode == .liveCapture ? .liveCapture : .fetch }

    /// Eagerly create the source inbox folder and the llm-doc notes folder so
    /// both exist from the moment a connector is connected (fixes the "no
    /// folders in sources/notes" regression). Idempotent and cheap.
    func ensureSetup(at root: URL) throws {
        let inbox = root.appendingPathComponent(manifest.inboxFolder, isDirectory: true)
        let notes = root.appendingPathComponent("llm-doc", isDirectory: true)
            .appendingPathComponent(manifest.noteType, isDirectory: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
    }

    @MainActor
    func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult {
        guard manifest.mode == .fetch else { return .none }
        let adapter = adapterFactory()
        let batch: SourceConnectorFetchBatch
        do {
            batch = try await adapter.fetch(ctx)
        } catch {
            return .failure(error.localizedDescription, imported: 0)
        }

        let inboxRoot = ctx.sourceConnectorRoot.appendingPathComponent(manifest.inboxFolder, isDirectory: true)
        for item in batch.items {
            let headers = resolveHeaders(from: item.fields)
            let slug = InboxStore.slugify(item.fields.values.first ?? manifest.id)
            do {
                _ = try InboxStore(root: inboxRoot).write(headers: headers, body: item.body, slug: slug)
            } catch {
                return .failure(error.localizedDescription, imported: 0)
            }
        }
        try? await adapter.markSeen(ctx, batch: batch, drained: batch.drained)

        // Notes writer's repoRoot is the parent of the connector root so its
        // notesRoot resolves to <sourceConnectorRoot>/llm-doc/.
        let writer = SourceConnectorNoteWriter(repoRoot: ctx.sourceConnectorRoot,
                                               noteType: NoteType(manifest.noteType), platform: manifest.id)
        let knownHashes = (try? await writer.existingSourceHashes()) ?? []
        let (processed, failures) = await InboxGenerationPipeline.run(
            inboxRoot: inboxRoot, knownHashes: knownHashes) { item in
                try await Self.generateNote(item: item, writer: writer, ctx: ctx,
                                            adapter: adapter, manifest: self.manifest)
            }

        if !batch.failures.isEmpty {
            return .failure(batch.failures.joined(separator: "; "), imported: processed)
        }
        if !failures.isEmpty {
            return .failure(failures.joined(separator: "; "), imported: processed)
        }
        if processed == 0 { return .none }
        return .imported(processed, moreAvailable: batch.overCap, oversize: 0)
    }

    /// Applies the manifest's rawHeaders mapping (e.g. "Channel": "$Channel")
    /// to the fetched item's fields, plus the `Date:` convention.
    private func resolveHeaders(from fields: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        for (headerKey, token) in manifest.rawHeaders {
            if token.hasPrefix("$") {
                out[headerKey] = fields[String(token.dropFirst())] ?? ""
            } else {
                out[headerKey] = token
            }
        }
        if out["Date"] == nil, let d = fields["Date"] { out["Date"] = d }
        return out
    }

    @MainActor
    private static func generateNote(
        item: RawInboxItem, writer: SourceConnectorNoteWriter, ctx: SourceContext,
        adapter: any SourceConnectorAdapter, manifest: SourceConnectorManifest
    ) async throws {
        let text = item.body
        let minLength = manifest.noiseFilter?.minLength ?? 0
        let emojiOnly = manifest.noiseFilter?.skipEmojiOnly ?? false
        let isNoise = text.trimmingCharacters(in: .whitespacesAndNewlines).count < max(1, minLength)
            || (emojiOnly && Self.isEmojiOnly(text))
        let title = item.headers["Subject"] ?? item.headers.values.first ?? manifest.displayName

        if isNoise {
            _ = try await writer.writeSkipped(headers: item.headers, title: title, date: item.date,
                                              category: "noise", originalBody: text, sourceHash: item.hash,
                                              rawFile: item.url.lastPathComponent)
            return
        }
        do {
            let req = adapter.classifyRequest(from: item)
            let c = try await ctx.api.postClassification(path: manifest.endpoints.classify, body: req.body)
            if c.noteWorthy {
                _ = try await writer.writeNote(headers: item.headers, title: title, date: item.date,
                                               classification: c, originalBody: text, sourceHash: item.hash,
                                               rawFile: item.url.lastPathComponent)
            } else {
                _ = try await writer.writeSkipped(headers: item.headers, title: title, date: item.date,
                                                  category: c.category, originalBody: text, sourceHash: item.hash,
                                                  rawFile: item.url.lastPathComponent)
            }
        } catch {
            _ = try await writer.writeSkipped(headers: item.headers, title: title, date: item.date,
                                              category: "unclassified", originalBody: text, sourceHash: item.hash,
                                              rawFile: item.url.lastPathComponent)
        }
    }

    private static func isEmojiOnly(_ s: String) -> Bool {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        return trimmed.unicodeScalars.allSatisfy {
            $0.properties.generalCategory == .modifierSymbol
            || $0.properties.generalCategory == .otherSymbol
            || $0.properties.generalCategory == .surrogate
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter SourceConnectorEngineTests`
Expected: PASS (setup + idempotent + note-writer). End-to-end `fetchAndIngest` test added in Task 9 (needs `ctx.sourceConnectorRoot`).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift
git commit -m "feat(mac): SourceConnector (ensureSetup + fetchAndIngest engine)"
```

---

### Task 9: `sourceConnectorRoot` setting + wire `SourceContext`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Sources/InputSource.swift:24-32` (`SourceContext`)
- Modify: `mac/Sources/LlmIdeMac/Services/SourceIngestService.swift:23-25`
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift` (add setting near other `@Published var *Source`)
- Test: `mac/Tests/LlmIdeMacTests/SourceConnectorRootTests.swift` + append engine end-to-end test

**Interfaces:**
- Produces: `SourceContext.sourceConnectorRoot: URL` (defaults to `root`). `AppConfig.sourceConnectorRoot: URL` (persisted override, default = project notes root). `SourceIngestService` constructed with it.

- [ ] **Step 1: Write the failing test**

`mac/Tests/LlmIdeMacTests/SourceConnectorRootTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceConnectorRootTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "sc-root-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    func testOverridePersistsAcrossInstances() {
        let project = FileManager.default.temporaryDirectory.appendingPathComponent("proj-\(UUID().uuidString)")
        let elsewhere = FileManager.default.temporaryDirectory.appendingPathComponent("elsewhere-\(UUID().uuidString)")
        let a = AppConfig(defaults: suite)
        a.projectRoot = project
        a.sourceConnectorRootOverride = elsewhere
        XCTAssertEqual(a.sourceConnectorRoot, elsewhere)

        let b = AppConfig(defaults: suite)
        b.projectRoot = project
        XCTAssertEqual(b.sourceConnectorRoot, elsewhere)
    }

    func testDefaultsToProjectRootWhenUnset() {
        let project = FileManager.default.temporaryDirectory.appendingPathComponent("proj2-\(UUID().uuidString)")
        let config = AppConfig(defaults: suite)
        config.projectRoot = project
        XCTAssertEqual(config.sourceConnectorRoot, project)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter SourceConnectorRootTests`
Expected: FAIL — `AppConfig` has no `sourceConnectorRoot`/`sourceConnectorRootOverride`/`projectRoot`.

- [ ] **Step 3: Add the setting to `AppConfig`**

In `mac/Sources/LlmIdeMac/Models/Config.swift`, beside the other `@Published var *Source` (after `boxSource`, ~line 422), add:

```swift
    /// Per-project base path under which all Source Connectors store data
    /// (`<root>/<inboxFolder>/`, `<root>/llm-doc/<noteType>/`). Defaults to the
    /// project root; user-overridable (UI picker lands in Plan B).
    @Published var sourceConnectorRootOverride: URL? {
        didSet {
            if let url = sourceConnectorRootOverride {
                defaults.set(url.path, forKey: "sourceConnectorRootOverride")
            } else {
                defaults.removeObject(forKey: "sourceConnectorRootOverride")
            }
        }
    }

    var sourceConnectorRoot: URL {
        sourceConnectorRootOverride ?? projectRoot
    }
```

And restore it in `init` (after the `boxSource` decode block, ~line 693):

```swift
        if let path = defaults.string(forKey: "sourceConnectorRootOverride") {
            self.sourceConnectorRootOverride = URL(fileURLWithPath: path)
        } else {
            self.sourceConnectorRootOverride = nil
        }
```

> `AppConfig` already has a persisted `projectRoot` (used by `AutoCodeUpdateService` / project switching) — `sourceConnectorRoot` defaults to it. If the property is named differently, match the existing name in both the default and the test rather than introducing a new one.

- [ ] **Step 4: Add `sourceConnectorRoot` to `SourceContext`**

In `mac/Sources/LlmIdeMac/Sources/InputSource.swift`, replace the `SourceContext` struct (lines 24-32):

```swift
@MainActor
struct SourceContext {
    let api: LlmIdeAPIClient
    let config: AppConfig
    /// Notes-folder root for `MeetingFileStore` (legacy meeting path).
    let root: URL
    /// `<project>/llm-doc/` — where the AI `.docx` note is written (legacy).
    let notesOutputFolder: URL
    /// Base path for all Source Connectors (`<root>/<inboxFolder>/`,
    /// `<root>/llm-doc/<noteType>/`). Defaults to `root` when unset.
    let sourceConnectorRoot: URL

    init(api: LlmIdeAPIClient, config: AppConfig, root: URL,
         notesOutputFolder: URL, sourceConnectorRoot: URL? = nil) {
        self.api = api
        self.config = config
        self.root = root
        self.notesOutputFolder = notesOutputFolder
        self.sourceConnectorRoot = sourceConnectorRoot ?? root
    }
}
```

- [ ] **Step 5: Wire `SourceIngestService` to pass it**

In `mac/Sources/LlmIdeMac/Services/SourceIngestService.swift`, update the `context` computed property (lines 23-25):

```swift
    private var context: SourceContext {
        SourceContext(api: api, config: config, root: root,
                      notesOutputFolder: notesOutputFolder,
                      sourceConnectorRoot: config.sourceConnectorRoot)
    }
```

- [ ] **Step 6: Append the end-to-end engine test**

Append to `SourceConnectorEngineTests.swift`:

```swift
@MainActor
extension SourceConnectorEngineTests {
    /// A SourceContext api that returns a worthy classification for any POST,
    /// without hitting the network. Conforms via the same `postClassification`
    /// seam as LlmIdeAPIClient.
    struct StubClassificationAPI: ClassificationCalling {
        func postClassification(path: String, body: [String: String]) async throws -> SourceConnectorClassification {
            SourceConnectorClassification(category: "work", noteWorthy: true, summary: "s",
                todos: [SourceConnectorClassification.Todo(title: "t", detail: "d", due: nil, priority: "med")])
        }
    }

    func testFetchAndIngestWritesNoteAndDedupsOnRerun() async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("sc-e2e-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let connector = SourceConnector(manifest: makeManifest(), adapterFactory: { FakeAdapter() })
        try connector.ensureSetup(at: tmp)

        // Build a SourceContext with a stub api. If SourceContext cannot be
        // constructed with a non-LlmIdeAPIClient api in this task's shape,
        // make `SourceContext.api` typed as `any ClassificationCalling` (and
        // have LlmIdeAPIClient conform) — the smaller edit.
        let ctx = SourceContext(api: StubClassificationAPI() as! LlmIdeAPIClient,
                                config: AppConfig(defaults: .standard),
                                root: tmp, notesOutputFolder: tmp.appendingPathComponent("llm-doc"),
                                sourceConnectorRoot: tmp)
        let r1 = await connector.fetchAndIngest(ctx)
        if case .imported(let n, _, _) = r1 { XCTAssertEqual(n, 1) } else { XCTFail("expected imported, got \(r1)") }

        let r2 = await connector.fetchAndIngest(ctx)
        if case .none = r2 { /* ok */ } else { XCTFail("expected .none on rerun, got \(r2)") }
    }
}
```

> The end-to-end test needs a stub `api`. The cleanest path: extract a `protocol ClassificationCalling { func postClassification(path:body:) async throws -> SourceConnectorClassification }`, make `LlmIdeAPIClient` conform, type `SourceContext.api` as `any ClassificationCalling` (it already only needs `postClassification` for connectors; if other call sites need the full `LlmIdeAPIClient`, keep `api: LlmIdeAPIClient` and instead inject the adapter's classify via a closure on `SourceContext`). Pick whichever is the smaller edit that keeps `EmailSource` (which uses `ctx.api.classifyEmail`) compiling.

- [ ] **Step 7: Run all tests + build**

Run: `cd mac && swift build && swift test`
Expected: BUILD green; `SourceConnectorRootTests` (2) + end-to-end engine test PASS.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Sources/InputSource.swift \
        mac/Sources/LlmIdeMac/Services/SourceIngestService.swift \
        mac/Sources/LlmIdeMac/Models/Config.swift \
        mac/Tests/LlmIdeMacTests/SourceConnectorRootTests.swift \
        mac/Tests/LlmIdeMacTests/SourceConnectorEngineTests.swift
git commit -m "feat(mac): sourceConnectorRoot setting + wire SourceContext"
```

---

## Self-Review (run after writing — already applied)

**Spec coverage:** engine core (manifest ✓ T6, SourceConnector ✓ T8, adapter ✓ T7, note writer ✓ T7), header-agnostic InboxStore ✓ T3, pipeline headers ✓ T4, string-backed NoteType ✓ T1–T2, base-path setting ✓ T9, eager folder creation ✓ T8 `ensureSetup`. Email adaptation (parity gate) ✓ T5. Deferred to **Plan B**: real `email.json`/`slack.json` manifests, `EmailConnectorAdapter`/`SlackConnectorAdapter`, `/kb/slack/classify` server endpoint, generic config UI + path picker, removal of the old Slack meeting-transcript path, `SourceConnectorRegistry` swap-in.

**Placeholders:** the two `>` notes (T7 step 3 `postClassification`, T9 step 6 stub-api seam) name concrete fallbacks (extract `ClassificationCalling` protocol), not bare TODOs.

**Type consistency:** `SourceConnectorFetchedItem`/`SourceConnectorFetchBatch`/`ClassifyRequest`/`SourceConnectorClassification.Todo` defined once (T7) and used identically in T8. `SourceContext.sourceConnectorRoot` (T9) is what T8 reads. `ensureSetup(at:)` and `llm-doc/<noteType>` consistent across T8 + its tests.

## Execution Handoff

**Plan A complete and saved to** `docs/superpowers/plans/2026-07-31-source-connector-engine.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach? (Plan B — Email migration + Slack connector + `/kb/slack/classify` + generic UI — follows once Plan A is green.)
