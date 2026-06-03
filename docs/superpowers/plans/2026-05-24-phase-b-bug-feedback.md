# Phase B — Bug Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user flag a bad agent answer from `CodeAssistantPanel` without leaving the conversation. The flagged answer becomes a markdown file under `<repo>/graphify-out/memory/bugs/` with frontmatter — visible to the user in the Memory tab and to the agent via Graphify's installed skill.

**Architecture:** Bugs are plain markdown files with YAML frontmatter, stored alongside Graphify's other memory artifacts. `MemoryStore` gains `writeBug` and `updateBugStatus`; a new `ReportBugSheet` collects user input and calls into the store; the existing assistant-message bubble in `CodeAssistantPanel` gains a small "Report this" button. The Memory tab gains per-row status pickers and an "open bug" badge in the header. No new persistence layer or schema.

**Tech Stack:** Swift 5.9 / SwiftUI / Yams (already a dep, used elsewhere for YAML). Test framework: Swift Testing (`@Test`).

**Spec:** [docs/superpowers/specs/2026-05-24-agent-memory-and-feedback-design.md](../specs/2026-05-24-agent-memory-and-feedback-design.md) — sub-project B only.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `mac/Sources/MeetNotesMac/CodeGraph/BugReport.swift` | `BugReport` struct + `BugSeverity` + `BugStatus` enums + frontmatter encode/decode. Pure data, no I/O. |
| `mac/Sources/MeetNotesMac/Views/CodeAssistant/ReportBugSheet.swift` | Compose sheet — severity picker, prompt (read-only), response (editable), notes textarea, tags, severity. Writes via `MemoryStore`. |
| `mac/Tests/MeetNotesMacTests/BugReportTests.swift` | Round-trip frontmatter encode/decode tests. |
| `mac/Tests/MeetNotesMacTests/MemoryStoreWritesTests.swift` | `writeBug` + `updateBugStatus` round-trip on tmp dir. |

**Modify:**

| Path | Why |
|---|---|
| `mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift` | Add `writeBug(at:_:)`, `loadBug(at:)`, `updateBugStatus(at:_:_:)`. |
| `mac/Sources/MeetNotesMac/Views/CodeAssistantPanel.swift:543-566` (`turnView`) | Add "Report this" button on assistant turns. Track the most recent user prompt to pre-fill the sheet. |
| `mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift` | Bug-row status picker; "N open bug reports" badge in the header alongside the existing node-count badge. |

---

## Task 1: `BugReport` model + frontmatter encode/decode

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeGraph/BugReport.swift`
- Create: `mac/Tests/MeetNotesMacTests/BugReportTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/MeetNotesMacTests/BugReportTests.swift`:

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct BugReportTests {
    @Test func encodeAndDecodeRoundTrip() throws {
        let bug = BugReport(
            prompt: "explain the auth flow",
            response: "Auth uses JWT and… (truncated)",
            notes: "It hallucinated the refresh-token endpoint.",
            severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc123def",
            appVersion: "0.1.0",
            agent: "claude_code",
            status: .open,
            tags: ["auth", "flow"]
        )

        let markdown = try bug.toMarkdown()
        let decoded = try BugReport.fromMarkdown(markdown)

        #expect(decoded.prompt == bug.prompt)
        #expect(decoded.response == bug.response)
        #expect(decoded.notes == bug.notes)
        #expect(decoded.severity == bug.severity)
        #expect(decoded.gitHead == bug.gitHead)
        #expect(decoded.appVersion == bug.appVersion)
        #expect(decoded.agent == bug.agent)
        #expect(decoded.status == bug.status)
        #expect(decoded.tags == bug.tags)
    }

    @Test func suggestedFileNameUsesISOTimestampAndSlug() {
        let bug = BugReport(
            prompt: "Explain THE Auth Flow!",
            response: "x", notes: "", severity: .minor,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: nil, appVersion: "0.1.0", agent: "claude_code",
            status: .open, tags: []
        )
        // 1_716_465_600 = 2024-05-23T12:00:00Z
        let name = bug.suggestedFileName()
        #expect(name.hasPrefix("2024-05-23T12-00-00Z-"))
        #expect(name.hasSuffix(".md"))
        // Slug derived from prompt: lowercase, alnum + dashes, capped.
        #expect(name.contains("explain-the-auth-flow"))
    }

    @Test func decodeMissingOptionalFieldsAcceptsDefaults() throws {
        // gitHead and tags are optional; status defaults to open if missing.
        let md = """
        ---
        prompt: "x"
        response: "y"
        severity: info
        reported_at: 2024-05-23T12:00:00Z
        app_version: "0.1.0"
        agent: claude_code
        ---
        the notes body
        """
        let decoded = try BugReport.fromMarkdown(md)
        #expect(decoded.gitHead == nil)
        #expect(decoded.tags.isEmpty)
        #expect(decoded.status == .open)
        #expect(decoded.notes == "the notes body")
    }

    @Test func decodeRejectsMalformedFrontmatter() {
        let md = "no frontmatter here"
        #expect(throws: BugReport.DecodeError.self) {
            _ = try BugReport.fromMarkdown(md)
        }
    }

    @Test func statusUpdateRewritesOnlyTheStatusField() throws {
        let bug = BugReport(
            prompt: "x", response: "y", notes: "z", severity: .minor,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc", appVersion: "0.1", agent: "claude_code",
            status: .open, tags: ["a"]
        )
        let md0 = try bug.toMarkdown()
        let md1 = try BugReport.rewritingStatus(in: md0, to: .fixed)
        let decoded = try BugReport.fromMarkdown(md1)
        #expect(decoded.status == .fixed)
        // Everything else preserved.
        #expect(decoded.prompt == "x")
        #expect(decoded.tags == ["a"])
        #expect(decoded.notes == "z")
    }
}
```

- [ ] **Step 2: Run tests, expect failures (`BugReport` doesn't exist)**

```
cd /Users/dinsmallade/Desktop/meet-notes/mac
swift test --filter BugReportTests
```

Expected: FAIL — `cannot find 'BugReport' in scope`.

- [ ] **Step 3: Implement BugReport**

Create `mac/Sources/MeetNotesMac/CodeGraph/BugReport.swift`:

```swift
// User-reported bug feedback. Persisted as a markdown file with YAML
// frontmatter under <repo>/graphify-out/memory/bugs/<slug>.md.
//
// Format chosen to be:
//   • Human-readable (open in any text editor).
//   • Agent-readable via Graphify's installed skill (which already
//     understands the memory/ dir convention).
//   • Diff-friendly (single status field updates touch one line).
//
// The notes body sits after the closing `---` so the user can edit it
// freely without breaking the frontmatter.

import Foundation
import Yams

enum BugSeverity: String, Codable, CaseIterable, Identifiable {
    case info
    case minor
    case major
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .info:  return "Info"
        case .minor: return "Minor"
        case .major: return "Major"
        }
    }
}

enum BugStatus: String, Codable, CaseIterable, Identifiable {
    case open
    case acknowledged
    case fixed
    case wontFix = "wont_fix"
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .open:         return "Open"
        case .acknowledged: return "Acknowledged"
        case .fixed:        return "Fixed"
        case .wontFix:      return "Won't fix"
        }
    }
}

struct BugReport: Equatable {
    var prompt: String
    var response: String
    var notes: String
    var severity: BugSeverity
    var reportedAt: Date
    /// Short git SHA at time of report. Optional — git may not be
    /// available or the repo path may not be a working tree.
    var gitHead: String?
    var appVersion: String
    /// `AICliTool.rawValue` of the agent that produced the response.
    var agent: String
    var status: BugStatus
    var tags: [String]

    enum DecodeError: Error, Equatable {
        case missingFrontmatter
        case invalidYAML(String)
    }

    // MARK: - File name

    /// `<ISO8601Z-with-dashes>-<slug>.md` so directory listings sort
    /// chronologically and the slug is human-readable.
    func suggestedFileName() -> String {
        let ts = Self.fsTimestampFormatter.string(from: reportedAt)
        return "\(ts)-\(Self.slugify(prompt)).md"
    }

    static func slugify(_ s: String) -> String {
        let lower = s.lowercased()
        let mapped = lower.map { ch -> Character in
            if ch.isLetter || ch.isNumber { return ch }
            return "-"
        }
        // Collapse runs of dashes, trim leading/trailing.
        var collapsed = ""
        var prevDash = false
        for ch in mapped {
            if ch == "-" {
                if !prevDash { collapsed.append(ch) }
                prevDash = true
            } else {
                collapsed.append(ch)
                prevDash = false
            }
        }
        let trimmed = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        // Cap at 60 chars so file names stay readable.
        return String(trimmed.prefix(60))
    }

    // MARK: - Markdown round-trip

    func toMarkdown() throws -> String {
        // Build a dictionary literal so Yams emits a deterministic
        // top-level field order. Using YAML block style with quoted
        // strings for prompt/response so multi-line content round-trips
        // without surprises.
        var fm: [String: Any] = [
            "prompt": prompt,
            "response": response,
            "severity": severity.rawValue,
            "reported_at": Self.isoFormatter.string(from: reportedAt),
            "app_version": appVersion,
            "agent": agent,
            "status": status.rawValue,
            "tags": tags
        ]
        if let gitHead { fm["git_head"] = gitHead }
        let yaml = try Yams.dump(object: fm)
        return "---\n\(yaml)---\n\(notes)"
    }

    static func fromMarkdown(_ source: String) throws -> BugReport {
        guard source.hasPrefix("---\n") else {
            throw DecodeError.missingFrontmatter
        }
        let afterOpen = source.index(source.startIndex, offsetBy: 4)
        guard let endRange = source.range(of: "\n---\n", range: afterOpen..<source.endIndex)
        else { throw DecodeError.missingFrontmatter }
        let yamlBlock = String(source[afterOpen..<endRange.lowerBound])
        let notes = String(source[endRange.upperBound...])
        let any: Any
        do { any = try Yams.load(yaml: yamlBlock) ?? [:] }
        catch { throw DecodeError.invalidYAML(String(describing: error)) }
        guard let dict = any as? [String: Any] else {
            throw DecodeError.invalidYAML("frontmatter is not a mapping")
        }
        guard let prompt = dict["prompt"] as? String,
              let response = dict["response"] as? String,
              let severityRaw = dict["severity"] as? String,
              let severity = BugSeverity(rawValue: severityRaw),
              let reportedAtStr = dict["reported_at"] as? String,
              let reportedAt = Self.parseDate(reportedAtStr),
              let appVersion = dict["app_version"] as? String,
              let agent = dict["agent"] as? String
        else { throw DecodeError.invalidYAML("missing required field") }
        let statusRaw = (dict["status"] as? String) ?? BugStatus.open.rawValue
        let status = BugStatus(rawValue: statusRaw) ?? .open
        let gitHead = dict["git_head"] as? String
        let tags = (dict["tags"] as? [String]) ?? []
        return BugReport(
            prompt: prompt, response: response, notes: notes,
            severity: severity, reportedAt: reportedAt, gitHead: gitHead,
            appVersion: appVersion, agent: agent, status: status, tags: tags
        )
    }

    /// Read existing markdown, rewrite only the status field, return the
    /// new source. Keeps the notes body byte-identical so user edits
    /// outside the frontmatter aren't disturbed.
    static func rewritingStatus(in source: String, to newStatus: BugStatus) throws -> String {
        let bug = try fromMarkdown(source)
        var copy = bug
        copy.status = newStatus
        return try copy.toMarkdown()
    }

    // MARK: - Date helpers

    static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Filesystem-safe ISO timestamp (colons are illegal on some FS).
    private static let fsTimestampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        return f
    }()

    private static func parseDate(_ s: String) -> Date? {
        isoFormatter.date(from: s)
    }
}
```

- [ ] **Step 4: Run tests, expect 5/5 PASS**

```
swift test --filter BugReportTests
```

- [ ] **Step 5: Commit**

```
git add mac/Sources/MeetNotesMac/CodeGraph/BugReport.swift mac/Tests/MeetNotesMacTests/BugReportTests.swift
git commit -m "feat(memory): BugReport model with YAML-frontmatter markdown round-trip

Phase B.1. Plain markdown so the user can open / edit the file in any
editor and the agent can read it via Graphify's installed skill. The
rewritingStatus helper preserves the notes body byte-for-byte so
status flips don't disturb user edits."
```

---

## Task 2: Extend `MemoryStore` with writes

**Files:**
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift`
- Create: `mac/Tests/MeetNotesMacTests/MemoryStoreWritesTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/MeetNotesMacTests/MemoryStoreWritesTests.swift`:

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct MemoryStoreWritesTests {
    private func tmpRepoDir() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("memory-writes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func sampleBug() -> BugReport {
        BugReport(
            prompt: "explain auth", response: "answer", notes: "wrong",
            severity: .major, reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc123", appVersion: "0.1.0", agent: "claude_code",
            status: .open, tags: ["auth"]
        )
    }

    @Test func writeBugCreatesBugsDirAndFile() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try store.writeBug(at: repo, sampleBug())

        let bugsDir = repo.appendingPathComponent("graphify-out/memory/bugs")
        #expect(FileManager.default.fileExists(atPath: bugsDir.path))
        #expect(FileManager.default.fileExists(atPath: url.path))
        #expect(url.lastPathComponent.hasSuffix(".md"))
    }

    @Test func loadBugReturnsRoundTrippedReport() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let written = sampleBug()
        let url = try store.writeBug(at: repo, written)

        let loaded = try store.loadBug(at: url)
        #expect(loaded.prompt == written.prompt)
        #expect(loaded.status == .open)
    }

    @Test func updateBugStatusFlipsFieldAndPersists() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try store.writeBug(at: repo, sampleBug())

        try store.updateBugStatus(at: url, to: .fixed)
        let loaded = try store.loadBug(at: url)
        #expect(loaded.status == .fixed)
    }

    @Test func listBugsSurfacesNewFile() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        #expect(store.listBugs(at: repo).isEmpty)
        _ = try store.writeBug(at: repo, sampleBug())
        #expect(store.listBugs(at: repo).count == 1)
    }
}
```

- [ ] **Step 2: Run tests, expect failures**

```
swift test --filter MemoryStoreWritesTests
```

Expected: FAIL — `value of type 'MemoryStore' has no member 'writeBug'`.

- [ ] **Step 3: Extend MemoryStore**

In `mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift`, add these methods at the end of the struct (before the closing brace, before the template constant):

```swift
    // MARK: - Bug writes (Phase B)

    /// Write a new bug report under `<repo>/graphify-out/memory/bugs/`.
    /// File name comes from `bug.suggestedFileName()` (ISO timestamp +
    /// slug) so listings naturally sort chronologically. Creates the
    /// bugs/ dir if needed; throws on FS errors or YAML serialisation
    /// failures.
    @discardableResult
    public func writeBug(at repo: URL, _ bug: BugReport) throws -> URL {
        let dir = bugsDir(in: repo)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(bug.suggestedFileName())
        let md = try bug.toMarkdown()
        try md.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    public func loadBug(at url: URL) throws -> BugReport {
        let md = try String(contentsOf: url, encoding: .utf8)
        return try BugReport.fromMarkdown(md)
    }

    /// In-place status flip. Reads the file, rewrites only the status
    /// frontmatter field, and writes back atomically. Notes body and
    /// other frontmatter fields are byte-preserved so user edits in
    /// other tools aren't disturbed.
    public func updateBugStatus(at url: URL, to newStatus: BugStatus) throws {
        let old = try String(contentsOf: url, encoding: .utf8)
        let updated = try BugReport.rewritingStatus(in: old, to: newStatus)
        try updated.write(to: url, atomically: true, encoding: .utf8)
    }
```

- [ ] **Step 4: Run tests, expect 4/4 PASS**

```
swift test --filter MemoryStoreWritesTests
```

- [ ] **Step 5: Commit**

```
git add mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift mac/Tests/MeetNotesMacTests/MemoryStoreWritesTests.swift
git commit -m "feat(memory): MemoryStore.writeBug + updateBugStatus

Phase B.2. Adds the write surface the bug-report sheet will call —
writeBug creates bugs/<slug>.md from a BugReport, loadBug round-trips
it back, updateBugStatus flips a single frontmatter field without
disturbing the notes body."
```

---

## Task 3: `ReportBugSheet` view

**Files:**
- Create: `mac/Sources/MeetNotesMac/Views/CodeAssistant/ReportBugSheet.swift`

- [ ] **Step 1: Create the dir + view file**

Run:

```
mkdir -p mac/Sources/MeetNotesMac/Views/CodeAssistant
```

Create `mac/Sources/MeetNotesMac/Views/CodeAssistant/ReportBugSheet.swift`:

```swift
// Compose sheet shown when the user clicks "Report this" on an
// assistant turn in CodeAssistantPanel. Pre-fills the prompt and
// response from the chat history; user adds notes + severity + tags
// and submits, which writes a markdown file under
// <repo>/graphify-out/memory/bugs/.
//
// The sheet is purely a UI concern. The data model (BugReport) and
// the persistence path (MemoryStore.writeBug) live in CodeGraph/.

import SwiftUI

struct ReportBugSheet: View {
    /// Prefilled prompt the agent was asked. Read-only — if the user
    /// wants to amend context, they put it in the notes field.
    let prompt: String
    /// Prefilled agent response. Editable in the sheet so the user can
    /// strip irrelevant chrome before saving.
    @State var response: String
    /// Active repo root. The sheet writes into
    /// `<repoRoot>/graphify-out/memory/bugs/`. Required — caller must
    /// have confirmed a repo is selected before presenting the sheet.
    let repoRoot: URL
    /// `AICliTool.rawValue` of the agent that produced the response.
    let agent: String

    var onSubmitted: (URL) -> Void
    var onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore

    @State private var notes: String = ""
    @State private var severity: BugSeverity = .major
    @State private var tagsField: String = ""
    @State private var submitting = false
    @State private var submitError: String?

    private let store = MemoryStore()

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("Report a bug").font(Typography.title).foregroundStyle(t.text)
                Spacer()
                Picker("", selection: $severity) {
                    ForEach(BugSeverity.allCases) { s in
                        Text(s.displayName).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Prompt").font(Typography.caption).foregroundStyle(t.textMuted)
                ScrollView {
                    Text(prompt)
                        .font(Typography.body).foregroundStyle(t.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 80)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Response (editable)").font(Typography.caption).foregroundStyle(t.textMuted)
                TextEditor(text: $response)
                    .font(Typography.body)
                    .frame(minHeight: 120, maxHeight: 200)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("What went wrong").font(Typography.caption).foregroundStyle(t.textMuted)
                TextEditor(text: $notes)
                    .font(Typography.body)
                    .frame(minHeight: 80, maxHeight: 160)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            }

            HStack(spacing: Spacing.md) {
                Text("Tags").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("comma or space separated", text: $tagsField)
                    .textFieldStyle(.roundedBorder)
                    .font(Typography.body)
            }

            if let err = submitError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(3).truncationMode(.tail)
            }

            HStack {
                Spacer()
                Button("Cancel") { onDismiss() }
                    .buttonStyle(.bordered)
                    .disabled(submitting)
                Button(submitting ? "Saving…" : "Save report") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(submitting || notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(Spacing.lg)
        .frame(minWidth: 600, idealWidth: 680, minHeight: 520)
    }

    // MARK: - Submit

    private func submit() async {
        submitting = true; submitError = nil
        defer { submitting = false }
        let tags = tagsField
            .split(whereSeparator: { $0.isWhitespace || $0 == "," })
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let bug = BugReport(
            prompt: prompt,
            response: response,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines),
            severity: severity,
            reportedAt: Date(),
            gitHead: GitHeadReader.shortHead(at: repoRoot),
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            agent: agent,
            status: .open,
            tags: tags
        )
        do {
            let url = try store.writeBug(at: repoRoot, bug)
            onSubmitted(url)
        } catch {
            submitError = "Couldn't save bug report: \(error.localizedDescription)"
        }
    }
}

/// Tiny utility — read `<repo>/.git/HEAD` and resolve to a short SHA.
/// Returns nil on any I/O / format issue; the caller treats nil as
/// "no git context available".
enum GitHeadReader {
    static func shortHead(at repo: URL) -> String? {
        let headURL = repo.appendingPathComponent(".git/HEAD")
        guard let head = try? String(contentsOf: headURL, encoding: .utf8) else { return nil }
        let trimmed = head.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("ref: ") {
            // Detached symbolic ref — read the resolved file.
            let ref = String(trimmed.dropFirst("ref: ".count))
            let refURL = repo.appendingPathComponent(".git/").appendingPathComponent(ref)
            guard let sha = try? String(contentsOf: refURL, encoding: .utf8) else { return nil }
            return String(sha.trimmingCharacters(in: .whitespacesAndNewlines).prefix(10))
        }
        // Detached HEAD — the file IS the SHA.
        return String(trimmed.prefix(10))
    }
}
```

- [ ] **Step 2: Build to confirm no compile errors**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 3: Commit**

```
git add mac/Sources/MeetNotesMac/Views/CodeAssistant/ReportBugSheet.swift
git commit -m "feat(memory): ReportBugSheet — compose UI for bug reports

Phase B.3. Pre-fills the agent's response + prompt from the chat
history; user adds severity / notes / tags. On Save, writes a
markdown file under graphify-out/memory/bugs/ via MemoryStore.
Includes a tiny GitHeadReader so each report records the SHA at
report-time (best-effort — no git fork)."
```

---

## Task 4: Wire "Report this" button into `CodeAssistantPanel`

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/CodeAssistantPanel.swift`

- [ ] **Step 1: Add state for the bug sheet**

Read `mac/Sources/MeetNotesMac/Views/CodeAssistantPanel.swift`. Find the `@State` block around line 30 and add:

```swift
    @State private var reportingBug: BugReportContext?

    /// Context passed to ReportBugSheet — captured at the moment the
    /// user clicks "Report this" so the sheet sees the prompt + answer
    /// that were on screen, not a later edit.
    struct BugReportContext: Identifiable {
        let id = UUID()
        let prompt: String
        let response: String
    }
```

- [ ] **Step 2: Add a "Report this" button to assistant turn bubbles**

Find `private func turnView(_ turn:)` (around line 543). Replace the function body with:

```swift
    @ViewBuilder
    private func turnView(_ turn: MeetNotesAPIClient.CodeAssistTurn) -> some View {
        let isUser = turn.role == .user
        HStack(alignment: .top, spacing: Spacing.sm) {
            if isUser { Spacer(minLength: 40) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                Text(isUser ? "You" : "Claude")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                Text(turn.content)
                    .font(.system(size: 12, design: turn.content.contains("```") ? .monospaced : .default))
                    .foregroundStyle(theme.current.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: 720, alignment: isUser ? .trailing : .leading)
                    .padding(10)
                    .background(isUser
                                ? theme.current.accent.opacity(0.14)
                                : theme.current.surface)
                    .cornerRadius(8)
                    .fixedSize(horizontal: false, vertical: true)
                if !isUser, activeRepoRoot != nil {
                    Button {
                        reportingBug = BugReportContext(
                            prompt: prevUserPrompt(before: turn) ?? "",
                            response: turn.content
                        )
                    } label: {
                        Label("Report this", systemImage: "ant")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    .buttonStyle(.plain)
                    .help("Save this answer as a bug report")
                }
            }
            if !isUser { Spacer(minLength: 40) }
        }
    }

    /// Walk backwards from `turn`'s position in `history` and return the
    /// most recent user message. Falls back to empty when the assistant
    /// answered without a preceding user turn (rare; agent self-prompts).
    private func prevUserPrompt(before turn: MeetNotesAPIClient.CodeAssistTurn) -> String? {
        guard let idx = history.firstIndex(where: { $0.id == turn.id }) else { return nil }
        for i in stride(from: idx - 1, through: 0, by: -1) {
            if history[i].role == .user { return history[i].content }
        }
        return nil
    }

    /// Resolve the active repo root for bug-report writes. Mirrors the
    /// pattern used by ReviewView (active+cloned project from either
    /// GitLab or GitHub). Returns nil when no repo is linked — the
    /// "Report this" button is hidden in that case so the user can't
    /// trigger a write that has nowhere to land.
    private var activeRepoRoot: URL? {
        if let p = config.gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned }),
           let url = p.localURL {
            return url
        }
        if let r = config.gitHubSavedRepos.first(where: { $0.isActive && $0.isCloned }),
           let url = r.localURL {
            return url
        }
        return nil
    }
```

NOTE: `config` access — verify CodeAssistantPanel already has `@EnvironmentObject var config: AppConfig` (search for `config:`). If not, add it near the existing environment objects.

- [ ] **Step 3: Present the sheet**

Find a `.sheet(item: …)` modifier already attached to the main body (search for `.sheet(`). Add a new sheet modifier for `reportingBug`. Pick a location alongside the existing sheets:

```swift
        .sheet(item: $reportingBug) { ctx in
            if let repoRoot = activeRepoRoot {
                ReportBugSheet(
                    prompt: ctx.prompt,
                    response: ctx.response,
                    repoRoot: repoRoot,
                    agent: config.activeCLI,
                    onSubmitted: { _ in reportingBug = nil },
                    onDismiss: { reportingBug = nil }
                )
            }
        }
```

- [ ] **Step 4: Build**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 5: Commit**

```
git add mac/Sources/MeetNotesMac/Views/CodeAssistantPanel.swift
git commit -m "feat(memory): wire 'Report this' button into CodeAssistantPanel

Phase B.4. Each assistant turn gains a small 'Report this' affordance
under the message bubble (visible only when a repo is linked). Tapping
opens ReportBugSheet pre-filled with the prompt + response captured
from the chat history at that moment."
```

---

## Task 5: Memory tab — bug status picker + open-count badge

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift`

- [ ] **Step 1: Track open-bug count**

In `MemoryTabView`, add `@State private var openBugCount: Int = 0` near the other state.

In `refresh()`, after the existing `bugs = store.listBugs(at: repoRoot)` line, add:

```swift
        openBugCount = bugs.compactMap { try? store.loadBug(at: $0) }
            .filter { $0.status == .open }
            .count
```

- [ ] **Step 2: Surface the badge in the header**

In `header`'s VStack (the one containing the install-skill button and node-count badge from Phase A), add ABOVE the node-count badge:

```swift
            if openBugCount > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "ant.fill")
                        .font(.system(size: 10)).foregroundStyle(t.danger)
                    Text("\(openBugCount) open bug report\(openBugCount == 1 ? "" : "s")")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                }
            }
```

- [ ] **Step 3: Status picker per bug row**

Find the `bugs` `Section { ForEach(bugs) … }` block in `itemList`. Replace the `ForEach` body with:

```swift
                    ForEach(bugs, id: \.self) { url in
                        bugRow(url: url)
                    }
```

Add the `bugRow` helper near `row(label:…)`:

```swift
    @ViewBuilder
    private func bugRow(url: URL) -> some View {
        let t = theme.current
        // Best-effort decode to surface the current status. A decode
        // failure (corrupt file, future schema) falls back to plain
        // filename styling so the user can still open and inspect.
        let bug = try? store.loadBug(at: url)
        HStack(spacing: 6) {
            Image(systemName: "ant")
                .foregroundStyle(bug?.status == .open ? t.danger : t.textMuted)
                .font(.system(size: 11))
            Text(url.lastPathComponent)
                .font(Typography.body).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if let bug = bug {
                Menu {
                    ForEach(BugStatus.allCases) { status in
                        Button {
                            Task { await setStatus(of: url, to: status) }
                        } label: {
                            if status == bug.status {
                                Label(status.displayName, systemImage: "checkmark")
                            } else {
                                Text(status.displayName)
                            }
                        }
                    }
                } label: {
                    Text(bug.status.displayName)
                        .font(.system(size: 9, weight: .heavy, design: .rounded))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(statusTint(bug.status).opacity(0.18)))
                        .foregroundStyle(statusTint(bug.status))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        }
        .tag(url)
    }

    /// Status flip via MemoryStore, then refresh the badge + list.
    private func setStatus(of url: URL, to status: BugStatus) async {
        do {
            try store.updateBugStatus(at: url, to: status)
            await refresh()
        } catch {
            installError = "Couldn't update bug status: \(error.localizedDescription)"
        }
    }

    private func statusTint(_ s: BugStatus) -> Color {
        let t = theme.current
        switch s {
        case .open:         return t.danger
        case .acknowledged: return t.accent2
        case .fixed:        return t.accent3
        case .wontFix:      return t.textMuted
        }
    }
```

- [ ] **Step 4: Build**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 5: Commit**

```
git add mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift
git commit -m "feat(memory): bug-status pickers + open-count badge in Memory tab

Phase B.5. Each bug row gains a status pill (Open / Acknowledged /
Fixed / Won't fix) backed by MemoryStore.updateBugStatus. The header
shows 'N open bug reports' when any bug has status == .open."
```

---

## Task 6: Full verification + smoke test

- [ ] **Step 1: Full test suite**

```
swift test 2>&1 | grep -cE "✘ Test"
```

Expected output: `2` (the two pre-existing unrelated failures from earlier audits — `agentContextEncodesEmptyFieldsAsNullAndEmptyArray`, `persistsAndLoadsAcrossInstances`). Any other failure means something regressed in this phase.

```
swift test --filter "BugReportTests|MemoryStoreWritesTests|MemoryStoreTests|GraphifyInstallerTests" 2>&1 | grep -E "(passed|failed)" | tail -5
```

Expected: all four suites pass.

- [ ] **Step 2: End-to-end manual walk**

```
./build_app.sh && pkill -f MeetNotesMac.app; sleep 1; open -n MeetNotesMac.app
```

Then:
1. Pick a repo as Active in Settings → GitLab/GitHub.
2. Open the Code Assistant panel (Library → meeting → "Code Assistant" affordance).
3. Send a prompt, receive a response.
4. Click **Report this** under the agent's message → sheet opens with prompt + response pre-filled.
5. Pick severity = Minor, type a note, add tags, hit **Save report**.
6. Open Graphify → Memory tab → bug appears under Bugs section. Header shows "1 open bug report".
7. Click the status pill on the bug row → menu shows Open / Acknowledged / Fixed / Won't fix with a check on the current status.
8. Set to **Fixed** → row's pill updates, header badge disappears (no more open bugs).
9. Open the `.md` file in your editor → frontmatter says `status: fixed`, notes body intact.

---

## Self-Review

**Spec coverage** (against Phase B in the spec):

| Spec requirement | Task |
|---|---|
| "Report this answer" button on each agent response | Task 4 (button in `turnView`) |
| Sheet with severity / prompt RO / response editable / notes / tags | Task 3 (`ReportBugSheet`) |
| File path `<repo>/graphify-out/memory/bugs/<ISO8601>-<slug>.md` | Task 1 (`suggestedFileName`), Task 2 (`writeBug`) |
| Frontmatter fields (prompt, response, severity, reported_at, git_head, app_version, agent, status, tags) | Task 1 (`BugReport.toMarkdown`) |
| Status lifecycle Open / Acknowledged / Fixed / Won't fix | Task 1 (`BugStatus` enum), Task 5 (picker UI) |
| Memory tab gains "N open bug reports" badge | Task 5 (Step 2) |
| Per-row status picker in Memory tab | Task 5 (Step 3) |
| Bug writes don't disturb notes body | Task 1 (`rewritingStatus` keeps body), Task 2 (uses it) |

**Placeholder scan:** No TBD / TODO / "add appropriate error handling" / placeholders. Every step has explicit code or a concrete command.

**Type consistency:**
- `BugReport.suggestedFileName()` → Task 1, used in Task 2's `writeBug`.
- `MemoryStore.writeBug(at:_:)` signature → Task 2, called by Task 3's `submit()`.
- `BugReportContext` → Task 4 declares + uses; same name in `.sheet(item:)` modifier.
- `activeRepoRoot` → Task 4 declares + uses inside `turnView` AND the sheet presentation.
- `BugStatus` cases consistent across Tasks 1, 2, 5 (`open / acknowledged / fixed / wontFix`).

No spec gap remaining.
