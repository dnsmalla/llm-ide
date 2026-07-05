# Email Note Generation Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple email note generation from the IMAP fetch/DB-dedup cycle by introducing a reusable "capture raw → generate note" pipeline (`InboxStore` + `InboxGenerationPipeline`), migrate `EmailSource` onto it, and remove the premature "Email To-dos" Library sidebar entry (keeping its backing code for later reuse).

**Architecture:** IMAP/OAuth fetch stays untouched and still uses the server's `email_seen`/`email_state` DB dedup to decide what to download. Each fetched message is now saved as a plain-text file into `<notesRoot>/EmailInbox/` via a new source-agnostic `InboxStore`. A new source-agnostic `InboxGenerationPipeline` then scans that folder, skips files whose SHA-256 content hash is already recorded in an existing note's frontmatter (`sourceHash`), and classifies + writes the rest via the existing `/kb/email/classify` + `EmailFileStore`. This decoupling means generation never touches the DB and re-processes whatever's in the folder, including manually-dropped files.

**Tech Stack:** Swift 5 (SwiftPM, macOS app), swift-testing (`@Suite`/`@Test`/`#expect`), Yams (YAML frontmatter), CryptoKit (SHA-256).

**Important environment note:** On this machine `swift test` compiles but does not execute tests (no local `xctest` runner — see `docs/superpowers/...` mac-build memory). Every "run the test" step below uses `swift test` to verify **compilation** (red: fails to compile because the referenced symbol doesn't exist yet; green: compiles cleanly). Actual pass/fail execution only happens in CI (`make test-mac`) or on a machine with full Xcode — the final task runs that check. All `swift build`/`swift test` invocations must run with the sandbox disabled and, if the build cache is warm, `GIT_CONFIG_GLOBAL=/dev/null` prefixed (per `mac/Scripts/build.sh`'s offline-resolve convention) — do not add `-c release`, use debug (default) for speed during iteration.

---

### Task 1: Add `sourceHash` to `EmailNoteFrontmatter`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/EmailNoteFrontmatter.swift`
- Test: `mac/Tests/LlmIdeMacTests/EmailNoteFrontmatterTests.swift` (new)

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/EmailNoteFrontmatterTests.swift`:

```swift
import Testing
import Foundation
import Yams
@testable import LlmIdeMac

@Suite("EmailNoteFrontmatter sourceHash")
struct EmailNoteFrontmatterTests {
  @Test func decodesSourceHashWhenPresent() throws {
    let yaml = """
    source: email
    from: "aki@co.com"
    date: 2026-07-05T00:00:00Z
    category: work
    noteWorthy: true
    sourceHash: "abc123"
    todos: []
    """
    let fm = try YAMLDecoder().decode(EmailNoteFrontmatter.self, from: yaml)
    #expect(fm.sourceHash == "abc123")
  }

  @Test func sourceHashDefaultsToNilWhenAbsent() throws {
    let yaml = """
    source: email
    from: "aki@co.com"
    date: 2026-07-05T00:00:00Z
    category: work
    noteWorthy: true
    todos: []
    """
    let fm = try YAMLDecoder().decode(EmailNoteFrontmatter.self, from: yaml)
    #expect(fm.sourceHash == nil)
  }
}
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter EmailNoteFrontmatterTests`
Expected: compile error — `value of type 'EmailNoteFrontmatter' has no member 'sourceHash'`

- [ ] **Step 3: Implement `sourceHash`**

In `mac/Sources/LlmIdeMac/Models/EmailNoteFrontmatter.swift`, replace the whole file body with:

```swift
// mac/Sources/LlmIdeMac/Models/EmailNoteFrontmatter.swift
import Foundation

/// Frontmatter shape written by `EmailFileStore` for email-derived to-do
/// notes. `date` is decoded as a plain `String` to avoid coupling this
/// reader to a specific date-decoding strategy. `todos` defaults to `[]`
/// so skipped notes (which omit the `todos` key entirely) decode cleanly.
/// `sourceHash` is the SHA-256 of the raw `EmailInbox/` file this note was
/// generated from (see `InboxGenerationPipeline`) — nil for notes written
/// before this field existed.
struct EmailNoteFrontmatter: Codable, Equatable {
    var source: String
    var from: String
    var date: String
    var category: String
    var noteWorthy: Bool
    var sourceHash: String?
    var todos: [Todo] = []

    struct Todo: Codable, Equatable {
        var title: String
        var detail: String
        var due: String?
        var priority: String
        var issue: String?
    }

    enum CodingKeys: String, CodingKey {
        case source, from, date, category, noteWorthy, sourceHash, todos
    }

    init(source: String, from: String, date: String, category: String, noteWorthy: Bool,
         sourceHash: String? = nil, todos: [Todo] = []) {
        self.source = source
        self.from = from
        self.date = date
        self.category = category
        self.noteWorthy = noteWorthy
        self.sourceHash = sourceHash
        self.todos = todos
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(String.self, forKey: .source)
        from = try container.decode(String.self, forKey: .from)
        date = try container.decode(String.self, forKey: .date)
        category = try container.decode(String.self, forKey: .category)
        noteWorthy = try container.decode(Bool.self, forKey: .noteWorthy)
        sourceHash = try container.decodeIfPresent(String.self, forKey: .sourceHash)
        todos = try container.decodeIfPresent([Todo].self, forKey: .todos) ?? []
    }
}
```

- [ ] **Step 4: Run test to verify it compiles clean**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter EmailNoteFrontmatterTests`
Expected: builds with no errors (execution is a no-op locally, per the environment note above).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/EmailNoteFrontmatter.swift mac/Tests/LlmIdeMacTests/EmailNoteFrontmatterTests.swift
git commit -m "feat(email): add sourceHash to EmailNoteFrontmatter"
```

---

### Task 2: `InboxStore` — raw capture writer

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/InboxStoreTests.swift` (new)

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/InboxStoreTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("InboxStore")
struct InboxStoreTests {
  private func tmpRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-\(UUID().uuidString)")
  }

  @Test func writesHeaderBlockThenBlankLineThenBody() throws {
    let root = tmpRoot()
    let store = InboxStore(root: root)
    let url = try store.write(from: "aki@co.com", date: Date(timeIntervalSince1970: 1_780_000_000),
                              subject: "Q3 numbers", body: "please send Q3")
    let text = try String(contentsOf: url, encoding: .utf8)
    #expect(text.hasPrefix("From: aki@co.com\nSubject: Q3 numbers\nDate: "))
    #expect(text.contains("\n\nplease send Q3"))
  }

  @Test func writesUnderYearMonthSubfolders() throws {
    let root = tmpRoot()
    let store = InboxStore(root: root)
    let url = try store.write(from: "a@b.com", date: Date(timeIntervalSince1970: 1_780_000_000),
                              subject: "hi", body: "hello")
    let comps = url.pathComponents
    #expect(comps.contains("2026"))
    #expect(comps.contains("06"))
    #expect(url.pathExtension == "txt")
  }

  @Test func emptySubjectFallsBackToItemSlug() throws {
    let root = tmpRoot()
    let store = InboxStore(root: root)
    let url = try store.write(from: "a@b.com", date: Date(timeIntervalSince1970: 1_780_000_000),
                              subject: "", body: "hello")
    #expect(url.lastPathComponent.contains("item"))
  }
}
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter InboxStoreTests`
Expected: compile error — `cannot find 'InboxStore' in scope`

- [ ] **Step 3: Implement `InboxStore`**

Create `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift`:

```swift
// mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift
import Foundation

/// Writes one raw captured item per file into `<root>/YYYY/MM/`. Pairs with
/// `InboxGenerationPipeline`, which scans what this writes. Together they
/// split "capture what arrived" from "generate a note from it" so
/// generation can run independently of however the raw content got here
/// (a live fetch, or a file dropped in by hand) and independently of any
/// fetch-side dedup state (DB, high-water marks, etc).
///
/// Files written here are never modified, moved, or deleted by the app —
/// they are the permanent raw record. Dedup for generation purposes is by
/// content hash, computed by `InboxGenerationPipeline` from the file bytes,
/// not tracked here.
struct InboxStore {
    let root: URL
    init(root: URL) { self.root = root }

    /// Writes `From:`/`Subject:`/`Date:` headers, a blank line, then `body`
    /// to `root/YYYY/MM/<yyyy-MM-dd-HHmmss>-<slug>.txt`. Returns the file URL.
    @discardableResult
    func write(from: String, date: Date, subject: String, body: String) throws -> URL {
        let contents = "From: \(from)\nSubject: \(subject)\nDate: \(AppDateFormatter.isoString(date))\n\n\(body)"
        let folder = monthFolder(for: date)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(filename(date: date, subject: subject))
        try Data(contents.utf8).write(to: url, options: .atomic)
        return url
    }

    private func monthFolder(for date: Date) -> URL {
        let c = Calendar.current.dateComponents([.year, .month], from: date)
        return root
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
    }

    private func filename(date: Date, subject: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        let stamp = f.string(from: date)
        let slug = Self.slugify(subject.isEmpty ? "item" : subject)
        return "\(stamp)-\(slug).txt"
    }

    private static func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "item" : String(collapsed.prefix(60))
    }
}
```

- [ ] **Step 4: Run test to verify it compiles clean**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter InboxStoreTests`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/NotesFolder/InboxStore.swift mac/Tests/LlmIdeMacTests/InboxStoreTests.swift
git commit -m "feat(email): add InboxStore for raw-capture files"
```

---

### Task 3: `InboxGenerationPipeline` — scan, hash-dedup, generate

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift`
- Test: `mac/Tests/LlmIdeMacTests/InboxGenerationPipelineTests.swift` (new)

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/InboxGenerationPipelineTests.swift`:

```swift
import Testing
import Foundation
import CryptoKit
@testable import LlmIdeMac

@Suite("InboxGenerationPipeline")
struct InboxGenerationPipelineTests {
  private func tmpRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("gen-\(UUID().uuidString)")
  }

  private func seedFile(root: URL, from: String, subject: String, date: String, body: String) throws {
    let store = InboxStore(root: root)
    _ = try store.write(from: from, date: AppDateFormatter.parseISO(date) ?? Date(), subject: subject, body: body)
  }

  @Test func generatesForUnknownHashesOnly() async throws {
    let root = tmpRoot()
    try seedFile(root: root, from: "a@co.com", subject: "one", date: "2026-07-01T00:00:00Z", body: "body one")
    try seedFile(root: root, from: "b@co.com", subject: "two", date: "2026-07-02T00:00:00Z", body: "body two")

    // Discover the hash of "one" up front so we can mark it as already-known.
    var discovered: [String] = []
    _ = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { item in
      discovered.append(item.hash)
    }
    let knownHash = discovered.first { _ in true }! // any one hash from the first pass

    var generated: [String] = []
    let (processed, failures) = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: [knownHash]) { item in
      generated.append(item.subject)
    }
    #expect(processed == 1)
    #expect(failures.isEmpty)
    #expect(generated.count == 1)
  }

  @Test func parsesHeaderFieldsAndBody() async throws {
    let root = tmpRoot()
    try seedFile(root: root, from: "aki@co.com", subject: "Q3 numbers", date: "2026-07-01T09:00:00Z", body: "please send Q3")

    var seen: RawInboxItem?
    _ = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { item in
      seen = item
    }
    #expect(seen?.from == "aki@co.com")
    #expect(seen?.subject == "Q3 numbers")
    #expect(seen?.body == "please send Q3")
  }

  @Test func oneFailureDoesNotStopTheRest() async throws {
    let root = tmpRoot()
    try seedFile(root: root, from: "a@co.com", subject: "one", date: "2026-07-01T00:00:00Z", body: "body one")
    try seedFile(root: root, from: "b@co.com", subject: "two", date: "2026-07-02T00:00:00Z", body: "body two")

    enum Boom: Error { case bad }
    var attempted: [String] = []
    let (processed, failures) = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { item in
      attempted.append(item.subject)
      if item.subject == "one" { throw Boom.bad }
    }
    #expect(attempted.count == 2)
    #expect(processed == 1)
    #expect(failures.count == 1)
  }

  @Test func emptyInboxProducesNoWork() async {
    let root = tmpRoot()
    let (processed, failures) = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { _ in }
    #expect(processed == 0)
    #expect(failures.isEmpty)
  }
}
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter InboxGenerationPipelineTests`
Expected: compile error — `cannot find 'InboxGenerationPipeline' in scope`

- [ ] **Step 3: Implement `InboxGenerationPipeline`**

Create `mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift`:

```swift
// mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift
import Foundation
import CryptoKit

/// One parsed raw item recovered from an `InboxStore` file, plus the raw
/// file's SHA-256 content hash — the dedup key `InboxGenerationPipeline`
/// checks against notes already generated.
struct RawInboxItem {
    let url: URL
    let from: String
    let subject: String
    let date: Date
    let body: String
    let hash: String
}

/// Generic "scan a raw-capture folder, skip what's already been turned into
/// a note, generate the rest" loop. Pairs with `InboxStore`: `InboxStore`
/// writes the raw files, this scans them. Dedup is by content hash, not by
/// message id or DB state — a file counts as done once the caller-supplied
/// `knownHashes` set (typically read from existing notes' frontmatter)
/// contains its hash. Source-agnostic and dependency-free (no networking,
/// no `SourceContext`) so it's reusable by any source with this shape.
enum InboxGenerationPipeline {
    /// Recursively finds every `.txt` file under `inboxRoot`, skips any
    /// whose content hash is in `knownHashes`, and calls `generate` for the
    /// rest. A `generate` throw is recorded in `failures` and does not stop
    /// the remaining items — matches `SlackSource.ingest`'s per-item
    /// failure isolation. Returns the count of items `generate` completed
    /// without throwing, plus any failure messages (`"<filename>: <error>"`).
    static func run(
        inboxRoot: URL,
        knownHashes: Set<String>,
        generate: (RawInboxItem) async throws -> Void
    ) async -> (processed: Int, failures: [String]) {
        guard let enumerator = FileManager.default.enumerator(at: inboxRoot, includingPropertiesForKeys: nil) else {
            return (0, [])
        }
        var processed = 0
        var failures: [String] = []
        for case let file as URL in enumerator {
            guard file.pathExtension.lowercased() == "txt" else { continue }
            guard let data = try? Data(contentsOf: file) else { continue }
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            if knownHashes.contains(hash) { continue }
            guard let item = parse(file: file, data: data, hash: hash) else { continue }
            do {
                try await generate(item)
                processed += 1
            } catch {
                failures.append("\(file.lastPathComponent): \(error.localizedDescription)")
            }
        }
        return (processed, failures)
    }

    /// Parses the `From:`/`Subject:`/`Date:` header block written by
    /// `InboxStore.write`. Returns nil (silently skips the file) if the
    /// headers, the blank-line separator, or the date can't be parsed.
    private static func parse(file: URL, data: Data, hash: String) -> RawInboxItem? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        guard let sep = text.range(of: "\n\n") else { return nil }
        let header = String(text[text.startIndex..<sep.lowerBound])
        let body = String(text[sep.upperBound...])

        var from = "", subject = "", dateStr = ""
        for line in header.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("From: ") { from = String(line.dropFirst("From: ".count)) }
            else if line.hasPrefix("Subject: ") { subject = String(line.dropFirst("Subject: ".count)) }
            else if line.hasPrefix("Date: ") { dateStr = String(line.dropFirst("Date: ".count)) }
        }
        guard let date = AppDateFormatter.parseISO(dateStr) else { return nil }
        return RawInboxItem(url: file, from: from, subject: subject, date: date, body: body, hash: hash)
    }
}
```

- [ ] **Step 4: Run test to verify it compiles clean**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter InboxGenerationPipelineTests`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/NotesFolder/InboxGenerationPipeline.swift mac/Tests/LlmIdeMacTests/InboxGenerationPipelineTests.swift
git commit -m "feat(email): add InboxGenerationPipeline for hash-deduped note generation"
```

---

### Task 4: `EmailFileStore` — write `sourceHash`, add `existingSourceHashes()`, drop unused `messageId`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/NotesFolder/EmailFileStore.swift`
- Modify: `mac/Tests/LlmIdeMacTests/EmailFileStoreTests.swift`

`messageId` is accepted by `writeNote`/`writeSkipped` today but was never written into the frontmatter (verified: the existing frontmatter template has no `messageId:` line) — it's dead. Since the generation pipeline has no message id to give it (dedup is now by content hash), this task drops the parameter instead of passing a meaningless empty string.

- [ ] **Step 1: Update the failing test**

Replace `mac/Tests/LlmIdeMacTests/EmailFileStoreTests.swift` in full:

```swift
import Testing
import Foundation
import Yams
@testable import LlmIdeMac

@Suite("EmailFileStore")
struct EmailFileStoreTests {
  private func tmpRoot() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("eml-\(UUID().uuidString)")
    return u
  }
  @Test func writesNoteWithFrontmatterAndTodos() throws {
    let root = tmpRoot()
    let store = EmailFileStore(root: root)
    let c = LlmIdeAPIClient.EmailClassification(
      category: "action_request", noteWorthy: true, summary: "Aki needs Q3.",
      todos: [.init(title: "Send Q3", detail: "by Fri", due: "2026-07-10", priority: "high")])
    let url = try store.writeNote(from: "aki@co.com",
      date: Date(timeIntervalSince1970: 1_780_000_000), subject: "Q3 numbers",
      classification: c, originalBody: "please send Q3", sourceHash: "hash123")
    let text = try String(contentsOf: url, encoding: .utf8)
    #expect(text.contains("source: email"))
    #expect(text.contains("category: action_request"))
    #expect(text.contains("noteWorthy: true"))
    #expect(text.contains("sourceHash: \"hash123\""))
    #expect(text.contains("title: \"Send Q3\""))
    #expect(text.contains("issue: null"))
    #expect(text.contains("**Summary:** Aki needs Q3."))
    #expect(text.contains("- [ ] Send Q3"))
    #expect(text.contains("please send Q3"))
  }
  @Test func writesSkippedRawStub() throws {
    let root = tmpRoot()
    let store = EmailFileStore(root: root)
    let url = try store.writeSkipped(from: "news@co.com",
      date: Date(timeIntervalSince1970: 1_780_000_000), subject: "Weekly",
      category: "newsletter", originalBody: "digest", sourceHash: "hash456")
    let text = try String(contentsOf: url, encoding: .utf8)
    #expect(text.contains("noteWorthy: false"))
    #expect(text.contains("skipped: newsletter"))
    #expect(text.contains("sourceHash: \"hash456\""))
    #expect(text.contains("digest"))
    #expect(!text.contains("## To-dos"))
  }
  @Test func isBulkSenderMatchesNoReply() {
    #expect(EmailFileStore.isBulkSender("No-Reply@example.com"))
    #expect(EmailFileStore.isBulkSender("Store <noreply@shop.com>"))
    #expect(EmailFileStore.isBulkSender("donotreply@bank.com"))
    #expect(!EmailFileStore.isBulkSender("aki@company.com"))
  }
  @Test func existingSourceHashesCollectsHashesFromNotesOnly() throws {
    let root = tmpRoot()
    let store = EmailFileStore(root: root)
    let c = LlmIdeAPIClient.EmailClassification(category: "work", noteWorthy: true, summary: "s", todos: [])
    _ = try store.writeNote(from: "a@co.com", date: Date(timeIntervalSince1970: 1_780_000_000),
      subject: "one", classification: c, originalBody: "b1", sourceHash: "hashA")
    _ = try store.writeSkipped(from: "b@co.com", date: Date(timeIntervalSince1970: 1_780_100_000),
      subject: "two", category: "bulk", originalBody: "b2", sourceHash: "hashB")
    let hashes = store.existingSourceHashes()
    #expect(hashes == Set(["hashA", "hashB"]))
  }
}
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter EmailFileStoreTests`
Expected: compile errors — `extra argument 'sourceHash' in call` / `missing argument for parameter 'messageId'` / `value of type 'EmailFileStore' has no member 'existingSourceHashes'`

- [ ] **Step 3: Implement the changes**

Replace `mac/Sources/LlmIdeMac/Services/NotesFolder/EmailFileStore.swift` in full:

```swift
// mac/Sources/LlmIdeMac/Services/NotesFolder/EmailFileStore.swift
import Foundation
import Yams

/// File-based email store. One complete `.md` per email under
/// `root/YYYY/MM/`. Note-worthy emails get a structured to-do note; skipped
/// (automated/bulk) emails get a raw stub. Files are the source of truth.
struct EmailFileStore {
    let root: URL
    init(root: URL) { self.root = root }

    /// Sender-address heuristic: automated senders never need an LLM call.
    static func isBulkSender(_ from: String) -> Bool {
        let lower = from.lowercased()
        return lower.contains("no-reply@") || lower.contains("noreply@") || lower.contains("donotreply@")
    }

    @discardableResult
    func writeNote(from: String, date: Date, subject: String,
                   classification c: LlmIdeAPIClient.EmailClassification,
                   originalBody: String, sourceHash: String) throws -> URL {
        var fm = """
        ---
        source: email
        platform: email
        from: \(yamlScalar(from))
        date: \(AppDateFormatter.isoString(date))
        category: \(c.category)
        noteWorthy: true
        sourceHash: \(yamlScalar(sourceHash))
        todos:

        """
        if c.todos.isEmpty { fm += "  []\n" }
        for t in c.todos {
            fm += "  - title: \(yamlScalar(t.title))\n"
            fm += "    detail: \(yamlScalar(t.detail))\n"
            fm += "    due: \(t.due.map { "\"\($0)\"" } ?? "null")\n"
            fm += "    priority: \(t.priority)\n"
            fm += "    issue: null\n"
        }
        fm += "---\n\n"

        var md = fm
        md += "# \(subject.isEmpty ? "Email" : subject)\n\n"
        md += "**Summary:** \(c.summary)\n\n"
        md += "## To-dos\n\n"
        if c.todos.isEmpty {
            md += "_No action items._\n\n"
        } else {
            for t in c.todos {
                let due = t.due.map { " — due \($0)" } ?? ""
                md += "- [ ] \(t.title)\(due) (\(t.priority))\n"
            }
            md += "\n"
        }
        md += "## Original\n\n\(originalBody)\n"
        return try write(md, date: date, subject: subject)
    }

    @discardableResult
    func writeSkipped(from: String, date: Date, subject: String,
                      category: String, originalBody: String, sourceHash: String) throws -> URL {
        let md = """
        ---
        source: email
        platform: email
        from: \(yamlScalar(from))
        date: \(AppDateFormatter.isoString(date))
        category: \(category)
        noteWorthy: false
        sourceHash: \(yamlScalar(sourceHash))
        skipped: \(category)
        ---

        # \(subject.isEmpty ? "Email" : subject)

        ## Original

        \(originalBody)
        """
        return try write(md, date: date, subject: subject)
    }

    /// Scans `root` for `.md` notes and collects every non-nil `sourceHash`
    /// from their frontmatter. Used by `InboxGenerationPipeline` (via
    /// `EmailSource`) to skip inbox files that already produced a note.
    /// Files that fail to parse are skipped, never thrown — same tolerance
    /// as `EmailNoteStore.scanOpenTodos`.
    func existingSourceHashes() -> Set<String> {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
            return []
        }
        var hashes: Set<String> = []
        for case let file as URL in enumerator {
            guard file.pathExtension.lowercased() == "md" else { continue }
            guard let contents = try? String(contentsOf: file, encoding: .utf8),
                  let split = FrontmatterCoder.split(file: contents),
                  let fm = try? YAMLDecoder().decode(EmailNoteFrontmatter.self, from: split.yaml),
                  let hash = fm.sourceHash else { continue }
            hashes.insert(hash)
        }
        return hashes
    }

    // MARK: - internals
    private func write(_ contents: String, date: Date, subject: String) throws -> URL {
        let folder = monthFolder(for: date)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(filename(date: date, subject: subject))
        try Data(contents.utf8).write(to: url, options: .atomic)
        return url
    }
    private func monthFolder(for date: Date) -> URL {
        let c = Calendar.current.dateComponents([.year, .month], from: date)
        return root
            .appendingPathComponent(String(format: "%04d", c.year ?? 0), isDirectory: true)
            .appendingPathComponent(String(format: "%02d", c.month ?? 0), isDirectory: true)
    }
    private func filename(date: Date, subject: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"; f.timeZone = TimeZone(identifier: "UTC")
        let stamp = f.string(from: date)
        let slug = slugify(subject.isEmpty ? "email" : subject)
        return "\(stamp)-\(slug).md"
    }
    private func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "email" : String(collapsed.prefix(60))
    }
    /// Quote a YAML scalar so ':' / '@' / quotes in addresses & titles stay valid.
    private func yamlScalar(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
```

- [ ] **Step 4: Run test to verify it compiles clean**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter EmailFileStoreTests`
Expected: builds with no errors.

- [ ] **Step 5: Search for other callers of the changed signatures**

Run: `grep -rn "\.writeNote(messageId\|\.writeSkipped(messageId" mac/Sources mac/Tests`
Expected: no matches (Task 5 will update `EmailSource.swift`, the only production caller — confirm here that nothing else calls the old signature before moving on).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/NotesFolder/EmailFileStore.swift mac/Tests/LlmIdeMacTests/EmailFileStoreTests.swift
git commit -m "feat(email): write sourceHash in EmailFileStore, add existingSourceHashes(), drop unused messageId param"
```

---

### Task 5: Rewire `EmailSource` onto the inbox pipeline

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Sources/EmailSource.swift`
- Test: `mac/Tests/LlmIdeMacTests/EmailSourceRoutingTests.swift` (verify still compiles, no changes expected — `routeDecision` is untouched)

- [ ] **Step 1: Confirm `routeDecision` test still applies unchanged**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter EmailSourceRoutingTests`
Expected: builds with no errors — `routeDecision` isn't changing in this task, this just re-confirms the baseline before the surrounding file changes.

- [ ] **Step 2: Replace `EmailSource.swift`**

Replace `mac/Sources/LlmIdeMac/Sources/EmailSource.swift` in full:

```swift
import Foundation

/// Ingested email. A fetch source: pulls NEW mail (the server owns the
/// forward-only high-water mark + seen-ledger) and saves each message as a
/// raw file into the `EmailInbox/` folder via `InboxStore`. Note generation
/// itself is decoupled from this fetch step — see `generateNote` below and
/// `InboxGenerationPipeline` — so it runs off whatever is in `EmailInbox/`
/// regardless of how it got there (fetched here, or dropped in by hand).
struct EmailSource: InputSource {
    let id = "email"
    let displayName = "Mail"          // Library SOURCES sub-group label
    let icon = "envelope"
    let emptyText = "No mail yet"
    let platforms = ["email"]
    let mode = SourceMode.fetch

    /// Safety cap on messages saved per fetch (first big drain imports the
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
            return .failure(error.localizedDescription, imported: 0)
        }

        let messages = result.messages
        let inboxRoot = ctx.root.appendingPathComponent("EmailInbox", isDirectory: true)
        let batch = Array(messages.prefix(Self.maxPerRun))
        let capped = messages.count > batch.count
        let moreAvailable = (messages.count - batch.count) + result.skipped.overCap

        var savedIds: [String] = []
        var saveFailure: String?
        for msg in batch {
            if Task.isCancelled { break }
            do {
                try saveRaw(from: msg, inboxRoot: inboxRoot)
                savedIds.append(msg.messageId)
            } catch {
                saveFailure = error.localizedDescription
                break
            }
        }
        let cancelled = Task.isCancelled
        let drained = !capped && saveFailure == nil && !cancelled
        try? await ctx.api.markEmailSeen(messageIds: savedIds,
                                         lastFetchedAt: drained ? fetchStart : nil)

        if let saveFailure { return .failure(saveFailure, imported: 0) }

        // Generation pass: scans the whole EmailInbox/ folder (not just what
        // was just saved above), so raw files added by hand are picked up
        // too. Dedup is by content hash against existing notes, not DB state.
        let emailRoot = ctx.root.appendingPathComponent("Email", isDirectory: true)
        let store = EmailFileStore(root: emailRoot)
        let knownHashes = store.existingSourceHashes()
        let (processed, failures) = await InboxGenerationPipeline.run(
            inboxRoot: inboxRoot, knownHashes: knownHashes
        ) { item in
            try await Self.generateNote(item: item, store: store, ctx: ctx)
        }

        if !failures.isEmpty {
            return .failure(failures.joined(separator: "; "), imported: processed)
        }
        if processed == 0 { return .none }
        return .imported(processed, moreAvailable: moreAvailable, oversize: result.skipped.oversize)
    }

    /// Saves one fetched message's raw content into `EmailInbox/`. No
    /// classification happens here — that's the generation pass's job.
    @MainActor
    private func saveRaw(from msg: EmailMessage, inboxRoot: URL) throws {
        let startedAt = AppDateFormatter.parseISO(msg.date) ?? Date()
        try InboxStore(root: inboxRoot).write(from: msg.from, date: startedAt, subject: msg.subject, body: msg.text)
    }

    /// The write action chosen for a classified email (pure, unit-testable).
    enum EmailWriteDecision: Equatable {
        case note(LlmIdeAPIClient.EmailClassification)
        case skipped(category: String)
    }

    /// Decide how to persist an email. Bulk senders skip the LLM entirely; a
    /// classify failure is persisted as a raw stub so nothing is lost.
    static func routeDecision(from: String,
                              classification: LlmIdeAPIClient.EmailClassification?,
                              classifyFailed: Bool = false) -> EmailWriteDecision {
        if EmailFileStore.isBulkSender(from) { return .skipped(category: "bulk") }
        if classifyFailed { return .skipped(category: "unclassified") }
        guard let c = classification else { return .skipped(category: "unclassified") }
        return c.noteWorthy ? .note(c) : .skipped(category: c.category)
    }

    /// Classifies one raw inbox item and writes the resulting note/skip stub
    /// via `EmailFileStore` — the `generate` step passed to
    /// `InboxGenerationPipeline.run`. Bulk senders skip the LLM call
    /// entirely, same as before this pipeline split.
    @MainActor
    private static func generateNote(item: RawInboxItem, store: EmailFileStore, ctx: SourceContext) async throws {
        if EmailFileStore.isBulkSender(item.from) {
            _ = try store.writeSkipped(from: item.from, date: item.date, subject: item.subject,
                                       category: "bulk", originalBody: item.body, sourceHash: item.hash)
            return
        }

        var classification: LlmIdeAPIClient.EmailClassification?
        var failed = false
        do {
            classification = try await ctx.api.classifyEmail(
                subject: item.subject, from: item.from,
                date: AppDateFormatter.isoString(item.date), body: item.body)
        } catch {
            failed = true
        }

        switch routeDecision(from: item.from, classification: classification, classifyFailed: failed) {
        case .note(let c):
            _ = try store.writeNote(from: item.from, date: item.date, subject: item.subject,
                                    classification: c, originalBody: item.body, sourceHash: item.hash)
        case .skipped(let category):
            _ = try store.writeSkipped(from: item.from, date: item.date, subject: item.subject,
                                       category: category, originalBody: item.body, sourceHash: item.hash)
        }
    }
}
```

- [ ] **Step 3: Run the full mac target build to catch any remaining call-site breakage**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: builds with no errors. If it references `makeNote` anywhere else, fix that call site (there should be none — `makeNote` was private to `EmailSource` and is fully replaced by `saveRaw` + `generateNote`).

- [ ] **Step 4: Run the full test target to catch orphaned references**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter EmailSourceRoutingTests`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Sources/EmailSource.swift
git commit -m "feat(email): decouple note generation from fetch via InboxStore/InboxGenerationPipeline"
```

---

### Task 6: Remove "Email To-dos" from the Library sidebar

Keep `EmailTodosView.swift`, `EmailTodosViewModel.swift`, `EmailNoteStore.swift`, `IssueTargetOptions.swift`, and their tests **as-is** — only the navigation entry point is removed.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryDetailView.swift`

- [ ] **Step 1: Remove the `.emailTodos` case from `ShellState.LibrarySelection`**

In `mac/Sources/LlmIdeMac/Services/ShellState.swift`, find:

```swift
        /// A skill row (built-in or plugin-contributed). String is the
        /// skill `name` from its frontmatter.
        case skill(String)
        /// The Email To-dos review panel (open to-dos extracted from email
        /// notes → create issues). No associated value — a single panel.
        case emailTodos
    }
```

Replace with:

```swift
        /// A skill row (built-in or plugin-contributed). String is the
        /// skill `name` from its frontmatter.
        case skill(String)
    }
```

- [ ] **Step 2: Remove the sidebar section from `LibraryView.swift`**

In `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift`, find:

```swift
            // ── Notes section ─────────────────────────────────────────
            fileTreeSection(.notes)

            // ── Email To-dos ──────────────────────────────────────────
            // Open to-dos extracted from email notes → review + file as issues.
            emailTodosSection

            // ── Agents section ────────────────────────────────────────
```

Replace with:

```swift
            // ── Notes section ─────────────────────────────────────────
            fileTreeSection(.notes)

            // ── Agents section ────────────────────────────────────────
```

Then find:

```swift
    // MARK: - Email To-dos section

    private var emailTodosSection: some View {
        Section("Email") {
            Label("Email To-dos", systemImage: "checklist")
                .tag(ShellState.LibrarySelection.emailTodos)
        }
    }

    // MARK: - File tree section
```

Replace with:

```swift
    // MARK: - File tree section
```

- [ ] **Step 3: Remove the `.emailTodos` case from `LibraryDetailView.swift`**

In `mac/Sources/LlmIdeMac/Views/Library/LibraryDetailView.swift`, find:

```swift
        case .plugin(let name):
            PluginDetailView(api: api, pluginName: name)

        case .emailTodos:
            EmailTodosView()

        case nil:
```

Replace with:

```swift
        case .plugin(let name):
            PluginDetailView(api: api, pluginName: name)

        case nil:
```

- [ ] **Step 4: Build to confirm the switch is still exhaustive and nothing else references the removed case**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: builds with no errors. If the compiler flags a non-exhaustive switch anywhere else, find and remove that `.emailTodos` arm too.

Run: `grep -rn "LibrarySelection.emailTodos\|case .emailTodos" mac/Sources mac/Tests`
Expected: no matches remain.

- [ ] **Step 5: Confirm the kept files still compile (they're now unreferenced but must still build)**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter EmailTodosViewModelTests`
Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter IssueTargetOptionsTests`
Expected: both build with no errors — confirms `EmailTodosView`/`EmailTodosViewModel`/`IssueTargetOptions` are untouched and ready for future reuse.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ShellState.swift mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift mac/Sources/LlmIdeMac/Views/Library/LibraryDetailView.swift
git commit -m "refactor(library): remove Email To-dos sidebar entry, keep backing code for later issue-filing work"
```

---

### Task 7: Document the capture → generate pipeline

**Files:**
- Modify: `docs/explanation/architecture.md`

- [ ] **Step 1: Add a new subsection**

In `docs/explanation/architecture.md`, immediately after the `## Data flow — meeting to outcome` section's last line (`7. **Outcome polling.**...outcomes` table.`) and before `## Tenancy`, insert:

```markdown

## Data flow — fetch sources: capture then generate

`MeetingSource` (live capture) has always split "record the raw thing" from
"generate a note from it": `MeetingFileStore` appends captions to a raw
transcript file as they arrive, and summarization only runs once capture
finishes. `EmailSource` (a `.fetch`-mode source) now follows the same shape,
generalized into two source-agnostic pieces so any future fetch source can
reuse them:

1. **Capture.** `InboxStore` writes one plain-text file per fetched item
   (`From:`/`Subject:`/`Date:` header block + body) into
   `<notesRoot>/<Name>Inbox/YYYY/MM/`. Files here are never modified, moved,
   or deleted.
2. **Generate.** `InboxGenerationPipeline` scans that folder, computes a
   SHA-256 of each file's raw bytes, skips any hash already recorded on an
   existing note (`sourceHash` in frontmatter), and calls a source-specific
   `generate` closure for the rest — collecting per-item failures without
   aborting the batch.

For email, capture and generation both run inside `EmailSource.fetchAndIngest`
back-to-back, but generation always re-scans the whole inbox folder rather
than just what was just fetched — so a file added by hand is picked up on
the next run too. Fetch-side dedup (the server's `email_seen`/`email_state`
tables, deciding what to *download*) is unrelated to generation-side dedup
(content hashes, deciding what to *turn into a note*) — the two layers don't
share state.

Slack's fetch source (`SlackSource`) does not yet use this pipeline — it
still generates immediately per fetch via the meeting pipeline. Migrating it
onto `InboxStore`/`InboxGenerationPipeline` is a planned follow-up.
```

- [ ] **Step 2: Check docs lint/build if one exists**

Run: `grep -n "docs-check" /Users/dinesh.malla/llm-ide/Makefile`

If a `docs-check` target exists, run it: `make docs-check`
Expected: passes (this is a prose-only addition, no schema/route changes).

- [ ] **Step 3: Commit**

```bash
git add docs/explanation/architecture.md
git commit -m "docs: describe the capture-then-generate pipeline pattern"
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full mac build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: exit 0, no errors.

- [ ] **Step 2: Full mac test target compiles**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test`
Expected: exit 0 (compiles; per the environment note, this does not execute assertions locally).

- [ ] **Step 3: Confirm no leftover references to removed/changed signatures**

Run: `grep -rn "writeNote(messageId\|writeSkipped(messageId\|EmailSource.makeNote\|LibrarySelection.emailTodos" mac/Sources mac/Tests`
Expected: no matches.

- [ ] **Step 4: Real CI/Xcode verification (required — cannot be skipped)**

This machine cannot execute the Swift test suite (see environment note at the top). Before considering this plan done, run `make test-mac` on a machine with full Xcode installed, or push and let CI run it, and confirm all tests — including the new `InboxStoreTests`, `InboxGenerationPipelineTests`, `EmailNoteFrontmatterTests`, and updated `EmailFileStoreTests` — actually pass at runtime, not just compile.

- [ ] **Step 5: Rebuild and manually verify the app**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null ./Scripts/build.sh`
Then relaunch: `open mac/LlmIdeMac.app`
Confirm: Library sidebar no longer shows "Email To-dos"; triggering an email fetch creates files under `<notesRoot>/EmailInbox/` and corresponding notes under `<notesRoot>/Email/` with a `sourceHash` field; re-running the fetch does not duplicate notes for files already processed.

- [ ] **Step 6: Final commit (if any fixups were needed)**

```bash
git status
# if there are unstaged fixups from steps above:
git add -A
git commit -m "fix: address issues found in full verification pass"
```
