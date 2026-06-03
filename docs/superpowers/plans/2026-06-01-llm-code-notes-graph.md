# LLM-Driven Code Notes & Graph System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-app system that orchestrates the user's AI coding CLI to generate InfiniteBrain-style markdown notes for project code, then derives an accurate knowledge graph from those notes' frontmatter links.

**Architecture:** A Swift orchestrator (`CodeNoteService`) drives a four-phase pipeline — SCAN (agent runs git ls-files + ripgrep), DIFF+BATCH (pure Swift fingerprint/batching), ANALYZE (agent writes notes + edges per batch), MERGE+RECOVER+DERIVE (pure Swift). Markdown notes are the source of truth; the graph is parsed from their frontmatter links so the two never drift.

**Tech Stack:** Swift 5.9+, SwiftUI, Swift Testing, Yams (YAML), CryptoKit (SHA-256), the existing `ProcessLauncher`/`AICliTool`/`CGData`/`CodeGraphCanvas`.

**Spec:** `docs/superpowers/specs/2026-06-01-llm-code-notes-graph-design.md`

**Scope note:** This plan delivers **file notes** (one per source file) plus
**per-symbol sub-notes** for oversized files, with module-level *navigation*
provided by the generated `index.md`. Full module-level *synthesis notes*
(an LLM-written architectural overview per module/folder) require a separate
architecture pass and are a fast-follow, not part of this plan — the note
format and parser already support `kind: module` notes, so they slot in later
without rework.

---

## File Structure

### New files — `mac/Sources/MeetNotesMac/CodeNotes/`

| File | Responsibility |
|------|---------------|
| `CodeNoteError.swift` | Error enum for the pipeline |
| `ScanResult.swift` | Codable model of Phase 1 agent output (files, imports, symbols) |
| `Fingerprint.swift` | SHA-256 per file; `FingerprintStore` load/save; change classifier |
| `BatchPlanner.swift` | Connected-components batching + neighbor map |
| `CodeNote.swift` | Note model + frontmatter Codable structs |
| `CodeNoteWriter.swift` | Write/read `.md` notes with YAML frontmatter round-trip |
| `CodeNoteParser.swift` | `notes/*.md` → `CGData` (frontmatter links → edges) |
| `EdgeRecovery.swift` | Re-add dropped import edges from `scan.json` |
| `IndexWriter.swift` | Generate `index.md` map of content |
| `ScanPhase.swift` | Build scan prompt, launch agent, read+decode `scan.json` |
| `AnalyzePhase.swift` | Build per-batch prompt, launch agent to write notes (edges in note frontmatter) |
| `CodeNoteService.swift` | Orchestrator: drives 4 phases, `@Published` progress |

### Modified files

| File | Change |
|------|--------|
| `mac/Sources/MeetNotesMac/CodeGraph/ProcessLauncher.swift` | Add `currentDirectory` parameter |
| `mac/Tests/MeetNotesMacTests/*` (any with a MockLauncher) | Update mock to new signature |
| `mac/Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift` | Add `codeNotes` mode + Generate button + progress |
| `mac/.gitignore` | Add `.code-notes/` |

### New test files — `mac/Tests/MeetNotesMacTests/`

`FingerprintTests.swift`, `BatchPlannerTests.swift`, `CodeNoteWriterTests.swift`, `CodeNoteParserTests.swift`, `EdgeRecoveryTests.swift`, `IndexWriterTests.swift`, `ScanPhaseTests.swift`, `AnalyzePhaseTests.swift`, `CodeNotePipelineIntegrationTests.swift`

---

## Task 1: Add `currentDirectory` to ProcessLauncher

The agent must run with its working directory set to the repo (for `git ls-files`, ripgrep). The current `ProcessLauncher` has no cwd parameter.

**Files:**
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/ProcessLauncher.swift`
- Modify: any test file defining a `MockLauncher` conforming to `ProcessLauncher`

- [ ] **Step 1: Find all ProcessLauncher conformances**

Run: `cd mac && grep -rln 'ProcessLauncher' Sources Tests`
Expected: lists `ProcessLauncher.swift` plus any tests with a `MockLauncher`. Note each `func run(executable:arguments:environment:)` you'll need to update.

- [ ] **Step 2: Update the protocol and SystemProcessLauncher**

In `ProcessLauncher.swift`, change the protocol requirement and implementation to add a `currentDirectory` parameter:

```swift
import Foundation

/// Minimal seam for unit testing agent/CLI invocation without spawning real processes.
public protocol ProcessLauncher: Sendable {
    /// Run an executable and await its exit. Honors Task cancellation by
    /// terminating the child. Returns (exitCode, stdoutData, stderrData).
    /// Throws `CancellationError` if cancelled.
    func run(executable: URL,
             arguments: [String],
             currentDirectory: URL?,
             environment: [String: String]?) async throws -> (Int32, Data, Data)
}

public struct SystemProcessLauncher: ProcessLauncher {
    public init() {}

    public func run(executable: URL,
                    arguments: [String],
                    currentDirectory: URL?,
                    environment: [String: String]?) async throws -> (Int32, Data, Data) {
        final class ProcBox: @unchecked Sendable {
            let lock = NSLock()
            var proc: Process?
            var cancelled = false
        }
        let box = ProcBox()

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Int32, Data, Data), Error>) in
                let proc = Process()
                proc.executableURL = executable
                proc.arguments = arguments
                if let cwd = currentDirectory { proc.currentDirectoryURL = cwd }
                if let env = environment { proc.environment = env }
                let outPipe = Pipe(); let errPipe = Pipe()
                proc.standardOutput = outPipe
                proc.standardError = errPipe
                proc.standardInput = FileHandle.nullDevice
                proc.terminationHandler = { p in
                    let out = ((try? outPipe.fileHandleForReading.readToEnd()) ?? nil) ?? Data()
                    let err = ((try? errPipe.fileHandleForReading.readToEnd()) ?? nil) ?? Data()
                    box.lock.lock()
                    let wasCancelled = box.cancelled
                    box.lock.unlock()
                    if wasCancelled {
                        cont.resume(throwing: CancellationError())
                    } else {
                        cont.resume(returning: (p.terminationStatus, out, err))
                    }
                }
                box.lock.lock()
                box.proc = proc
                let alreadyCancelled = box.cancelled
                box.lock.unlock()
                if alreadyCancelled {
                    cont.resume(throwing: CancellationError())
                    return
                }
                do {
                    try proc.run()
                } catch {
                    cont.resume(throwing: error)
                }
            }
        } onCancel: {
            box.lock.lock()
            box.cancelled = true
            let p = box.proc
            box.lock.unlock()
            if let p, p.isRunning { p.terminate() }
        }
    }
}
```

- [ ] **Step 3: Update every MockLauncher in tests**

For each `MockLauncher` found in Step 1, change its `run` signature to include `currentDirectory: URL?`. Capture it if useful, otherwise ignore. Example edit pattern:

```swift
func run(executable: URL, arguments: [String], currentDirectory: URL?, environment: [String: String]?) async throws -> (Int32, Data, Data) {
    capturedExecutable = executable
    capturedArgs = arguments
    capturedCwd = currentDirectory
    return (exitCode, stdout, stderr)
}
```
Add a `var capturedCwd: URL?` property where the other captured properties live.

- [ ] **Step 4: Build to verify**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!` (fix any conformance errors by adding the new parameter).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeGraph/ProcessLauncher.swift mac/Tests/MeetNotesMacTests
git commit -m "feat(codegraph): add currentDirectory to ProcessLauncher for agent cwd"
```

---

## Task 2: CodeNoteError and ScanResult models

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/CodeNoteError.swift`
- Create: `mac/Sources/MeetNotesMac/CodeNotes/ScanResult.swift`

- [ ] **Step 1: Create CodeNoteError.swift**

```swift
import Foundation

public enum CodeNoteError: Error, Equatable {
    case cliMissing
    case folderNotWritable(path: String)
    case scanFailed(message: String)
    case analyzeFailed(batch: Int, message: String)
    case noScanOutput
    case parseFailed(message: String)
    case cancelled
}
```

- [ ] **Step 2: Create ScanResult.swift**

```swift
import Foundation

/// Phase 1 ground truth: deterministic structural facts the agent emits
/// by running git ls-files + ripgrep/ctags. Written to
/// `<repo>/.code-notes/scan.json` and decoded here.
public struct ScanResult: Codable, Equatable, Sendable {
    public struct FileEntry: Codable, Equatable, Sendable {
        public let path: String          // relative to repo root
        public let language: String
        public let loc: Int
    }
    public struct Symbol: Codable, Equatable, Sendable {
        public let name: String
        public let kind: String          // function | class | struct | ...
        public let line: Int
    }

    public let files: [FileEntry]
    /// path -> repo-internal import target paths (external packages dropped)
    public let imports: [String: [String]]
    /// path -> symbols defined in that file
    public let symbols: [String: [Symbol]]

    public init(files: [FileEntry],
                imports: [String: [String]],
                symbols: [String: [Symbol]]) {
        self.files = files
        self.imports = imports
        self.symbols = symbols
    }

    public static func decode(_ data: Data) throws -> ScanResult {
        do { return try AppJSON.decoder.decode(ScanResult.self, from: data) }
        catch { throw CodeNoteError.parseFailed(message: error.localizedDescription) }
    }
}
```

- [ ] **Step 3: Build**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/CodeNoteError.swift mac/Sources/MeetNotesMac/CodeNotes/ScanResult.swift
git commit -m "feat(codenotes): add CodeNoteError and ScanResult models"
```

---

## Task 3: Fingerprint + FingerprintStore + change classifier

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/Fingerprint.swift`
- Test: `mac/Tests/MeetNotesMacTests/FingerprintTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct FingerprintTests {
    @Test func hashIsStableForSameContent() {
        let a = Fingerprint.hash(of: Data("hello".utf8))
        let b = Fingerprint.hash(of: Data("hello".utf8))
        #expect(a == b)
        #expect(!a.isEmpty)
    }

    @Test func hashDiffersForDifferentContent() {
        let a = Fingerprint.hash(of: Data("hello".utf8))
        let b = Fingerprint.hash(of: Data("world".utf8))
        #expect(a != b)
    }

    @Test func classifyDetectsUnchangedChangedNewDeleted() {
        let previous = ["a.ts": "h1", "b.ts": "h2", "gone.ts": "h3"]
        let current  = ["a.ts": "h1", "b.ts": "CHANGED", "new.ts": "h4"]
        let result = Fingerprint.classify(previous: previous, current: current)
        #expect(result.unchanged == ["a.ts"])
        #expect(result.changed.sorted() == ["b.ts", "new.ts"])
        #expect(result.deleted == ["gone.ts"])
    }

    @Test func storeRoundTripsThroughJSON() throws {
        let store = FingerprintStore(hashes: ["a.ts": "h1", "b.ts": "h2"])
        let data = try store.encoded()
        let restored = try FingerprintStore.decode(data)
        #expect(restored.hashes == store.hashes)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter FingerprintTests 2>&1 | tail -5`
Expected: FAIL — `Fingerprint` not defined.

- [ ] **Step 3: Implement Fingerprint.swift**

```swift
import Foundation
import CryptoKit

public enum Fingerprint {
    /// SHA-256 hex digest of file content.
    public static func hash(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public struct Classification: Equatable {
        public let unchanged: [String]
        public let changed: [String]   // changed + new
        public let deleted: [String]
    }

    /// Compare previous vs current path->hash maps.
    public static func classify(previous: [String: String],
                                current: [String: String]) -> Classification {
        var unchanged: [String] = []
        var changed: [String] = []
        for (path, hash) in current {
            if previous[path] == hash { unchanged.append(path) }
            else { changed.append(path) }
        }
        let deleted = previous.keys.filter { current[$0] == nil }
        return Classification(unchanged: unchanged.sorted(),
                              changed: changed.sorted(),
                              deleted: deleted.sorted())
    }
}

/// Persisted path->hash map at `<repo>/.code-notes/fingerprints.json`.
public struct FingerprintStore: Codable, Equatable, Sendable {
    public var hashes: [String: String]
    public init(hashes: [String: String] = [:]) { self.hashes = hashes }

    public func encoded() throws -> Data { try AppJSON.encoder.encode(self) }
    public static func decode(_ data: Data) throws -> FingerprintStore {
        try AppJSON.decoder.decode(FingerprintStore.self, from: data)
    }

    public static func load(from url: URL) -> FingerprintStore {
        guard let data = try? Data(contentsOf: url),
              let store = try? decode(data) else { return FingerprintStore() }
        return store
    }
    public func save(to url: URL) throws {
        try encoded().write(to: url, options: .atomic)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter FingerprintTests 2>&1 | tail -5`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/Fingerprint.swift mac/Tests/MeetNotesMacTests/FingerprintTests.swift
git commit -m "feat(codenotes): add Fingerprint hashing, store, and change classifier"
```

---

## Task 4: BatchPlanner — connected-components batching + neighbor map

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/BatchPlanner.swift`
- Test: `mac/Tests/MeetNotesMacTests/BatchPlannerTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import MeetNotesMac

struct BatchPlannerTests {
    @Test func importConnectedFilesShareABatch() {
        // a imports b; c is isolated. With maxBatchSize 10, {a,b} together.
        let imports = ["a": ["b"], "b": [], "c": []]
        let batches = BatchPlanner.plan(files: ["a", "b", "c"], imports: imports, maxBatchSize: 10)
        let batchOfA = batches.first { $0.files.contains("a") }!
        #expect(batchOfA.files.contains("b"))
        #expect(!batchOfA.files.contains("c"))
    }

    @Test func respectsMaxBatchSize() {
        // 5 mutually-connected files, maxBatchSize 2 → at least 3 batches.
        let imports = ["a": ["b"], "b": ["c"], "c": ["d"], "d": ["e"], "e": ["a"]]
        let files = ["a", "b", "c", "d", "e"]
        let batches = BatchPlanner.plan(files: files, imports: imports, maxBatchSize: 2)
        #expect(batches.allSatisfy { $0.files.count <= 2 })
        let total = batches.reduce(0) { $0 + $1.files.count }
        #expect(total == 5)
    }

    @Test func neighborMapHasCrossBatchImports() {
        // a imports b but maxBatchSize 1 forces them apart; a's neighborMap
        // should include b.
        let imports = ["a": ["b"], "b": []]
        let batches = BatchPlanner.plan(files: ["a", "b"], imports: imports, maxBatchSize: 1)
        let batchOfA = batches.first { $0.files.contains("a") }!
        #expect(batchOfA.neighbors["a"]?.contains("b") == true)
    }

    @Test func emptyInputProducesNoBatches() {
        let batches = BatchPlanner.plan(files: [], imports: [:], maxBatchSize: 10)
        #expect(batches.isEmpty)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter BatchPlannerTests 2>&1 | tail -5`
Expected: FAIL — `BatchPlanner` not defined.

- [ ] **Step 3: Implement BatchPlanner.swift**

```swift
import Foundation

public struct CodeBatch: Equatable, Sendable {
    public let index: Int
    public let files: [String]
    /// For each file in this batch: 1-hop import neighbors that live in
    /// OTHER batches (so the agent can write cross-batch edges).
    public let neighbors: [String: [String]]
}

public enum BatchPlanner {
    /// Group files into batches by import-connectivity (connected
    /// components), splitting components larger than `maxBatchSize`.
    public static func plan(files: [String],
                            imports: [String: [String]],
                            maxBatchSize: Int = 20) -> [CodeBatch] {
        guard !files.isEmpty else { return [] }
        let fileSet = Set(files)

        // Build undirected adjacency from imports (only edges between files
        // we're actually analyzing).
        var adj: [String: Set<String>] = [:]
        for f in files { adj[f] = [] }
        for (src, targets) in imports where fileSet.contains(src) {
            for t in targets where fileSet.contains(t) {
                adj[src, default: []].insert(t)
                adj[t, default: []].insert(src)
            }
        }

        // Connected components via BFS over the undirected graph.
        var visited = Set<String>()
        var components: [[String]] = []
        for f in files.sorted() where !visited.contains(f) {
            var comp: [String] = []
            var queue = [f]
            visited.insert(f)
            while let cur = queue.first {
                queue.removeFirst()
                comp.append(cur)
                for n in (adj[cur] ?? []).sorted() where !visited.contains(n) {
                    visited.insert(n)
                    queue.append(n)
                }
            }
            components.append(comp.sorted())
        }

        // Split oversized components into chunks of maxBatchSize.
        var rawBatches: [[String]] = []
        for comp in components {
            if comp.count <= maxBatchSize {
                rawBatches.append(comp)
            } else {
                var i = 0
                while i < comp.count {
                    rawBatches.append(Array(comp[i..<min(i + maxBatchSize, comp.count)]))
                    i += maxBatchSize
                }
            }
        }

        // Assign each file to its batch index, then compute cross-batch neighbors.
        var batchOf: [String: Int] = [:]
        for (idx, b) in rawBatches.enumerated() { for f in b { batchOf[f] = idx } }

        return rawBatches.enumerated().map { idx, batchFiles in
            var neighbors: [String: [String]] = [:]
            for f in batchFiles {
                let crossBatch = (adj[f] ?? []).filter { batchOf[$0] != idx }.sorted()
                if !crossBatch.isEmpty { neighbors[f] = crossBatch }
            }
            return CodeBatch(index: idx, files: batchFiles.sorted(), neighbors: neighbors)
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter BatchPlannerTests 2>&1 | tail -5`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/BatchPlanner.swift mac/Tests/MeetNotesMacTests/BatchPlannerTests.swift
git commit -m "feat(codenotes): add BatchPlanner with connected-components batching + neighbor map"
```

---

## Task 5: CodeNote model + CodeNoteWriter (YAML round-trip)

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/CodeNote.swift`
- Create: `mac/Sources/MeetNotesMac/CodeNotes/CodeNoteWriter.swift`
- Test: `mac/Tests/MeetNotesMacTests/CodeNoteWriterTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct CodeNoteWriterTests {
    private func sampleNote() -> CodeNote {
        CodeNote(
            id: "file:src/a.ts",
            kind: "file",
            title: "a.ts",
            path: "src/a.ts",
            language: "typescript",
            complexity: "moderate",
            tags: ["api", "core"],
            contentHash: "abc123",
            symbols: [CodeNote.SymbolRef(name: "foo", kind: "function", line: 5)],
            links: [CodeNote.Link(to: "file:src/b.ts", kind: "imports")],
            body: "## Summary\nDoes a thing.\n"
        )
    }

    @Test func roundTripsThroughMarkdown() throws {
        let note = sampleNote()
        let md = try CodeNoteWriter.render(note)
        let parsed = try CodeNoteWriter.parse(md)
        #expect(parsed.id == note.id)
        #expect(parsed.kind == note.kind)
        #expect(parsed.tags == note.tags)
        #expect(parsed.contentHash == note.contentHash)
        #expect(parsed.links.first?.to == "file:src/b.ts")
        #expect(parsed.links.first?.kind == "imports")
        #expect(parsed.symbols.first?.name == "foo")
        #expect(parsed.body.contains("Does a thing."))
    }

    @Test func renderedMarkdownStartsWithFrontmatter() throws {
        let md = try CodeNoteWriter.render(sampleNote())
        #expect(md.hasPrefix("---\n"))
        #expect(md.contains("\nid: file:src/a.ts"))
    }

    @Test func parseRejectsMissingFrontmatter() {
        #expect(throws: CodeNoteError.self) {
            try CodeNoteWriter.parse("no frontmatter here")
        }
    }

    @Test func writeThenReadFromDisk() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("codenote-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("a.md")
        try CodeNoteWriter.write(sampleNote(), to: url)
        let loaded = try CodeNoteWriter.read(from: url)
        #expect(loaded.id == "file:src/a.ts")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter CodeNoteWriterTests 2>&1 | tail -5`
Expected: FAIL — `CodeNote` / `CodeNoteWriter` not defined.

- [ ] **Step 3: Implement CodeNote.swift**

```swift
import Foundation

/// One atomic code note. Frontmatter is machine-readable (drives the
/// graph); `body` is human/LLM-readable markdown.
public struct CodeNote: Equatable, Sendable {
    public struct SymbolRef: Equatable, Sendable {
        public let name: String
        public let kind: String
        public let line: Int
        public init(name: String, kind: String, line: Int) {
            self.name = name; self.kind = kind; self.line = line
        }
    }
    public struct Link: Equatable, Sendable {
        public let to: String      // target node id
        public let kind: String    // edge kind (imports, calls, contains, ...)
        public init(to: String, kind: String) { self.to = to; self.kind = kind }
    }

    public let id: String
    public let kind: String        // file | function | module | ...
    public let title: String
    public let path: String?
    public let language: String?
    public let complexity: String?
    public let tags: [String]
    public let contentHash: String?
    public let symbols: [SymbolRef]
    public let links: [Link]
    public let body: String

    public init(id: String, kind: String, title: String, path: String? = nil,
                language: String? = nil, complexity: String? = nil,
                tags: [String] = [], contentHash: String? = nil,
                symbols: [SymbolRef] = [], links: [Link] = [], body: String = "") {
        self.id = id; self.kind = kind; self.title = title; self.path = path
        self.language = language; self.complexity = complexity; self.tags = tags
        self.contentHash = contentHash; self.symbols = symbols
        self.links = links; self.body = body
    }
}
```

- [ ] **Step 4: Implement CodeNoteWriter.swift**

```swift
import Foundation
import Yams

/// Renders/parses CodeNote to/from markdown with a YAML frontmatter block.
public enum CodeNoteWriter {

    public static func render(_ note: CodeNote) throws -> String {
        var fm: [String: Any] = [
            "id": note.id,
            "kind": note.kind,
            "title": note.title,
            "tags": note.tags,
        ]
        if let p = note.path { fm["path"] = p }
        if let l = note.language { fm["language"] = l }
        if let c = note.complexity { fm["complexity"] = c }
        if let h = note.contentHash { fm["content_hash"] = h }
        if !note.symbols.isEmpty {
            fm["symbols"] = note.symbols.map { ["name": $0.name, "kind": $0.kind, "line": $0.line] }
        }
        if !note.links.isEmpty {
            fm["links"] = note.links.map { ["to": $0.to, "kind": $0.kind] }
        }
        let yaml = try Yams.dump(object: fm)
        return "---\n\(yaml)---\n\(note.body)"
    }

    public static func parse(_ source: String) throws -> CodeNote {
        guard source.hasPrefix("---\n") else {
            throw CodeNoteError.parseFailed(message: "note missing frontmatter")
        }
        let afterOpen = source.index(source.startIndex, offsetBy: 4)
        guard let endRange = source.range(of: "\n---\n", range: afterOpen..<source.endIndex) else {
            throw CodeNoteError.parseFailed(message: "note frontmatter not closed")
        }
        let yamlBlock = String(source[afterOpen..<endRange.lowerBound])
        let body = String(source[endRange.upperBound...])

        let any: Any
        do { any = try Yams.load(yaml: yamlBlock) ?? [:] }
        catch { throw CodeNoteError.parseFailed(message: "bad YAML: \(error.localizedDescription)") }
        guard let dict = any as? [String: Any] else {
            throw CodeNoteError.parseFailed(message: "frontmatter is not a mapping")
        }

        let id = (dict["id"] as? String) ?? ""
        let kind = (dict["kind"] as? String) ?? "other"
        let title = (dict["title"] as? String) ?? id
        let tags = (dict["tags"] as? [String]) ?? []

        let symbols: [CodeNote.SymbolRef] = (dict["symbols"] as? [[String: Any]] ?? []).compactMap { s in
            guard let n = s["name"] as? String else { return nil }
            return CodeNote.SymbolRef(name: n,
                                      kind: (s["kind"] as? String) ?? "",
                                      line: (s["line"] as? Int) ?? 0)
        }
        let links: [CodeNote.Link] = (dict["links"] as? [[String: Any]] ?? []).compactMap { l in
            guard let to = l["to"] as? String, let k = l["kind"] as? String else { return nil }
            return CodeNote.Link(to: to, kind: k)
        }

        return CodeNote(
            id: id, kind: kind, title: title,
            path: dict["path"] as? String,
            language: dict["language"] as? String,
            complexity: dict["complexity"] as? String,
            tags: tags,
            contentHash: dict["content_hash"] as? String,
            symbols: symbols, links: links, body: body
        )
    }

    public static func write(_ note: CodeNote, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try render(note).write(to: url, atomically: true, encoding: .utf8)
    }

    public static func read(from url: URL) throws -> CodeNote {
        let src = try String(contentsOf: url, encoding: .utf8)
        return try parse(src)
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd mac && swift test --filter CodeNoteWriterTests 2>&1 | tail -5`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/CodeNote.swift mac/Sources/MeetNotesMac/CodeNotes/CodeNoteWriter.swift mac/Tests/MeetNotesMacTests/CodeNoteWriterTests.swift
git commit -m "feat(codenotes): add CodeNote model + CodeNoteWriter YAML round-trip"
```

---

## Task 6: CodeNoteParser — notes → CGData

Reuses the existing `UAParser.mapNodeType` / `UAParser.mapEdgeType` (already `public static`) for string→enum mapping, so we don't duplicate alias tables.

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/CodeNoteParser.swift`
- Test: `mac/Tests/MeetNotesMacTests/CodeNoteParserTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import MeetNotesMac

struct CodeNoteParserTests {
    private func note(_ id: String, kind: String, links: [CodeNote.Link]) -> CodeNote {
        CodeNote(id: id, kind: kind, title: id, links: links)
    }

    @Test func derivesNodesAndEdgesFromNotes() {
        let notes = [
            note("file:a.ts", kind: "file",
                 links: [CodeNote.Link(to: "file:b.ts", kind: "imports")]),
            note("file:b.ts", kind: "file", links: []),
        ]
        let data = CodeNoteParser.derive(from: notes)
        #expect(data.nodes.count == 2)
        #expect(data.edges.count == 1)
        #expect(data.edges.first?.fromId == "file:a.ts")
        #expect(data.edges.first?.toId == "file:b.ts")
        #expect(data.edges.first?.kind == .imports)
    }

    @Test func dropsDanglingEdges() {
        // link target has no node → edge dropped.
        let notes = [
            note("file:a.ts", kind: "file",
                 links: [CodeNote.Link(to: "file:ghost.ts", kind: "imports")]),
        ]
        let data = CodeNoteParser.derive(from: notes)
        #expect(data.nodes.count == 1)
        #expect(data.edges.isEmpty)
    }

    @Test func mapsKnownNodeAndEdgeKinds() {
        let notes = [
            note("class:Foo", kind: "class",
                 links: [CodeNote.Link(to: "file:a.ts", kind: "depends_on")]),
            note("file:a.ts", kind: "file", links: []),
        ]
        let data = CodeNoteParser.derive(from: notes)
        let cls = data.nodes.first { $0.id == "class:Foo" }!
        #expect(cls.kind == .classType)
        #expect(data.edges.first?.kind == .dependsOn)
    }

    @Test func unknownKindsFallBack() {
        let notes = [
            note("x:1", kind: "alien",
                 links: [CodeNote.Link(to: "x:2", kind: "teleports")]),
            note("x:2", kind: "alien", links: []),
        ]
        let data = CodeNoteParser.derive(from: notes)
        #expect(data.nodes.first?.kind == .other)
        #expect(data.edges.first?.kind == .relatedTo)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter CodeNoteParserTests 2>&1 | tail -5`
Expected: FAIL — `CodeNoteParser` not defined.

- [ ] **Step 3: Implement CodeNoteParser.swift**

```swift
import Foundation

/// Derives a CGData graph from a set of code notes. The notes' frontmatter
/// links ARE the edges; dangling edges (target node absent) are dropped.
/// Node/edge kind strings are mapped via UAParser's existing alias tables.
public enum CodeNoteParser {

    public static func derive(from notes: [CodeNote]) -> CGData {
        let nodeIds = Set(notes.map { $0.id })

        let nodes: [CGNode] = notes.map { note in
            var meta: [String: String] = [:]
            if let p = note.path { meta["source_file"] = p }
            if let l = note.language { meta["language"] = l }
            if let c = note.complexity { meta["complexity"] = c }
            if !note.tags.isEmpty { meta["tags"] = note.tags.joined(separator: ", ") }
            if !note.body.isEmpty { meta["summary"] = firstSummaryLine(note.body) }
            return CGNode(id: note.id,
                          title: note.title,
                          kind: UAParser.mapNodeType(note.kind),
                          position: .zero,
                          metadata: meta)
        }

        var edges: [CGEdge] = []
        for note in notes {
            for link in note.links where nodeIds.contains(link.to) {
                edges.append(CGEdge(fromId: note.id,
                                    toId: link.to,
                                    kind: UAParser.mapEdgeType(link.kind)))
            }
        }
        return CGData(nodes: nodes, edges: edges)
    }

    /// Extract the first non-empty prose line after a "## Summary" heading,
    /// or the first non-heading line, for the node detail panel.
    static func firstSummaryLine(_ body: String) -> String {
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
        var sawSummaryHeading = false
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.lowercased().hasPrefix("## summary") { sawSummaryHeading = true; continue }
            if sawSummaryHeading && !line.isEmpty { return line }
        }
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if !line.isEmpty && !line.hasPrefix("#") { return line }
        }
        return ""
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter CodeNoteParserTests 2>&1 | tail -5`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/CodeNoteParser.swift mac/Tests/MeetNotesMacTests/CodeNoteParserTests.swift
git commit -m "feat(codenotes): add CodeNoteParser deriving CGData from note links"
```

---

## Task 7: EdgeRecovery — re-add dropped import edges

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/EdgeRecovery.swift`
- Test: `mac/Tests/MeetNotesMacTests/EdgeRecoveryTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import MeetNotesMac

struct EdgeRecoveryTests {
    @Test func reAddsMissingImportEdges() {
        // scan says a imports b, but the notes produced no import edge.
        let notes = [
            CodeNote(id: "file:a.ts", kind: "file", title: "a", links: []),
            CodeNote(id: "file:b.ts", kind: "file", title: "b", links: []),
        ]
        let recovered = EdgeRecovery.recover(
            notes: notes,
            imports: ["a.ts": ["b.ts"]])
        let aLinks = recovered.first { $0.id == "file:a.ts" }!.links
        #expect(aLinks.contains { $0.to == "file:b.ts" && $0.kind == "imports" })
    }

    @Test func doesNotDuplicateExistingImportEdges() {
        let notes = [
            CodeNote(id: "file:a.ts", kind: "file", title: "a",
                     links: [CodeNote.Link(to: "file:b.ts", kind: "imports")]),
            CodeNote(id: "file:b.ts", kind: "file", title: "b", links: []),
        ]
        let recovered = EdgeRecovery.recover(notes: notes, imports: ["a.ts": ["b.ts"]])
        let aLinks = recovered.first { $0.id == "file:a.ts" }!.links
        #expect(aLinks.filter { $0.to == "file:b.ts" && $0.kind == "imports" }.count == 1)
    }

    @Test func skipsImportsToFilesWithoutNotes() {
        let notes = [CodeNote(id: "file:a.ts", kind: "file", title: "a", links: [])]
        let recovered = EdgeRecovery.recover(notes: notes, imports: ["a.ts": ["missing.ts"]])
        let aLinks = recovered.first { $0.id == "file:a.ts" }!.links
        #expect(aLinks.isEmpty)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter EdgeRecoveryTests 2>&1 | tail -5`
Expected: FAIL — `EdgeRecovery` not defined.

- [ ] **Step 3: Implement EdgeRecovery.swift**

```swift
import Foundation

/// Deterministic safety net: the LLM is told to transcribe imports 1:1 but
/// drops some in practice. After analysis, re-add any import edge present
/// in scan.json that's missing from the notes. Import paths are converted
/// to `file:<path>` node ids; targets without a note are skipped.
public enum EdgeRecovery {

    public static func recover(notes: [CodeNote],
                               imports: [String: [String]]) -> [CodeNote] {
        let noteIds = Set(notes.map { $0.id })
        var byId = Dictionary(uniqueKeysWithValues: notes.map { ($0.id, $0) })

        for (srcPath, targets) in imports {
            let srcId = "file:\(srcPath)"
            guard var note = byId[srcId] else { continue }
            var links = note.links
            for t in targets {
                let targetId = "file:\(t)"
                guard noteIds.contains(targetId) else { continue }
                let exists = links.contains { $0.to == targetId && $0.kind == "imports" }
                if !exists {
                    links.append(CodeNote.Link(to: targetId, kind: "imports"))
                }
            }
            note = CodeNote(id: note.id, kind: note.kind, title: note.title,
                            path: note.path, language: note.language,
                            complexity: note.complexity, tags: note.tags,
                            contentHash: note.contentHash, symbols: note.symbols,
                            links: links, body: note.body)
            byId[srcId] = note
        }
        // Preserve original order.
        return notes.map { byId[$0.id] ?? $0 }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter EdgeRecoveryTests 2>&1 | tail -5`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/EdgeRecovery.swift mac/Tests/MeetNotesMacTests/EdgeRecoveryTests.swift
git commit -m "feat(codenotes): add EdgeRecovery to re-add dropped import edges"
```

---

## Task 8: IndexWriter — map of content

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/IndexWriter.swift`
- Test: `mac/Tests/MeetNotesMacTests/IndexWriterTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import MeetNotesMac

struct IndexWriterTests {
    @Test func rendersStatsAndGroupsByKind() {
        let notes = [
            CodeNote(id: "module:ext", kind: "module", title: "Extension", path: "ext"),
            CodeNote(id: "file:ext/a.ts", kind: "file", title: "a.ts", path: "ext/a.ts"),
            CodeNote(id: "file:ext/b.ts", kind: "file", title: "b.ts", path: "ext/b.ts"),
        ]
        let md = IndexWriter.render(notes: notes)
        #expect(md.contains("# Code Notes Index"))
        #expect(md.contains("3 notes"))
        #expect(md.contains("Extension"))
        #expect(md.contains("a.ts"))
        #expect(md.contains("b.ts"))
    }

    @Test func emptyNotesStillRendersHeader() {
        let md = IndexWriter.render(notes: [])
        #expect(md.contains("# Code Notes Index"))
        #expect(md.contains("0 notes"))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter IndexWriterTests 2>&1 | tail -5`
Expected: FAIL — `IndexWriter` not defined.

- [ ] **Step 3: Implement IndexWriter.swift**

```swift
import Foundation

/// Generates the InfiniteBrain "map of content" — a top-level index.md
/// linking to all notes, grouped by kind (modules first, then files).
public enum IndexWriter {

    public static func render(notes: [CodeNote]) -> String {
        var out = "# Code Notes Index\n\n"
        out += "> \(notes.count) notes. Auto-generated — the notes are the source of truth.\n\n"

        let modules = notes.filter { $0.kind == "module" }.sorted { $0.title < $1.title }
        let files = notes.filter { $0.kind == "file" }.sorted { ($0.path ?? "") < ($1.path ?? "") }
        let others = notes.filter { $0.kind != "module" && $0.kind != "file" }
            .sorted { $0.title < $1.title }

        if !modules.isEmpty {
            out += "## Modules\n\n"
            for m in modules { out += "- \(m.title) — `\(m.path ?? m.id)`\n" }
            out += "\n"
        }
        if !files.isEmpty {
            out += "## Files\n\n"
            for f in files { out += "- \(f.title) — `\(f.path ?? f.id)`\n" }
            out += "\n"
        }
        if !others.isEmpty {
            out += "## Symbols & Other\n\n"
            for o in others { out += "- \(o.title) (`\(o.kind)`)\n" }
            out += "\n"
        }
        return out
    }

    public static func write(notes: [CodeNote], to url: URL) throws {
        try render(notes: notes).write(to: url, atomically: true, encoding: .utf8)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter IndexWriterTests 2>&1 | tail -5`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/IndexWriter.swift mac/Tests/MeetNotesMacTests/IndexWriterTests.swift
git commit -m "feat(codenotes): add IndexWriter for map-of-content index.md"
```

---

## Task 9: ScanPhase — build prompt, launch agent, read scan.json

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/ScanPhase.swift`
- Test: `mac/Tests/MeetNotesMacTests/ScanPhaseTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct ScanPhaseTests {
    final class MockLauncher: ProcessLauncher, @unchecked Sendable {
        var capturedArgs: [String] = []
        var capturedCwd: URL?
        var exitCode: Int32 = 0
        /// Runs before returning, so the test can simulate the agent
        /// writing scan.json to disk.
        var onRun: (() -> Void)?
        func run(executable: URL, arguments: [String], currentDirectory: URL?, environment: [String: String]?) async throws -> (Int32, Data, Data) {
            capturedArgs = arguments
            capturedCwd = currentDirectory
            onRun?()
            return (exitCode, Data(), Data())
        }
    }

    @Test func promptMentionsScanJsonAndTools() {
        let prompt = ScanPhase.buildPrompt(outputPath: ".code-notes/scan.json")
        #expect(prompt.contains("scan.json"))
        #expect(prompt.contains("git ls-files"))
        #expect(prompt.contains("ripgrep") || prompt.contains("rg "))
    }

    @Test func runReadsScanJsonAgentWrote() async throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("scan-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }

        let launcher = MockLauncher()
        launcher.onRun = {
            let dir = repo.appendingPathComponent(".code-notes")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let json = #"{"files":[{"path":"a.ts","language":"typescript","loc":10}],"imports":{"a.ts":[]},"symbols":{"a.ts":[]}}"#
            try? json.write(to: dir.appendingPathComponent("scan.json"), atomically: true, encoding: .utf8)
        }
        let phase = ScanPhase(launcher: launcher, cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        let result = try await phase.run(repoRoot: repo).get()
        #expect(result.files.count == 1)
        #expect(result.files.first?.path == "a.ts")
        #expect(launcher.capturedCwd == repo)
    }

    @Test func runFailsWhenNoScanOutput() async {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("scan-empty-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let launcher = MockLauncher()  // writes nothing
        let phase = ScanPhase(launcher: launcher, cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        let result = await phase.run(repoRoot: repo)
        #expect(result == .failure(.noScanOutput))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter ScanPhaseTests 2>&1 | tail -5`
Expected: FAIL — `ScanPhase` not defined.

- [ ] **Step 3: Implement ScanPhase.swift**

```swift
import Foundation

/// Phase 1: instruct the agent to run deterministic structure-extraction
/// tools and write scan.json, then read it back.
public final class ScanPhase {
    private let launcher: ProcessLauncher
    private let cliExecutable: URL

    public init(launcher: ProcessLauncher, cliExecutable: URL) {
        self.launcher = launcher
        self.cliExecutable = cliExecutable
    }

    public static func buildPrompt(outputPath: String) -> String {
        """
        You are a code-structure scanner. Do NOT analyze meaning. Run these
        steps using your Bash tool, then WRITE the result as JSON.

        Hard rules:
        - You are NOT in conversation mode. Do NOT ask questions.
        - Do everything with your Bash/Write tools NOW. Do not summarize.

        Steps:
        1. List tracked source files: `git ls-files` (if not a git repo, walk
           the tree). Skip node_modules, .build, dist, .git, vendored deps,
           lockfiles, and binary files.
        2. For each code file, use `ripgrep` (rg) to find its import/require
           statements. Resolve each import to a repo-internal RELATIVE path.
           Drop external packages (anything not resolving to a file in this repo).
        3. For each code file, list symbol definitions (functions, classes,
           structs, types) with line numbers — use `rg` patterns (and `ctags`
           if available) to find them.
        4. Count non-empty lines of code per file.

        WRITE the result to `\(outputPath)` (relative to the repo root) as
        JSON with EXACTLY this shape:
        {
          "files": [{"path": "<rel>", "language": "<lang>", "loc": <int>}],
          "imports": {"<rel path>": ["<rel path>", ...]},
          "symbols": {"<rel path>": [{"name": "<n>", "kind": "<k>", "line": <int>}]}
        }

        Every code file must appear as a key in both `imports` and `symbols`
        (use [] when empty). Ensure the JSON is valid: closed brackets, quoted
        strings, no trailing commas. When the file is written, stop.
        """
    }

    public func run(repoRoot: URL) async -> Result<ScanResult, CodeNoteError> {
        if !FileManager.default.isWritableFile(atPath: repoRoot.path) {
            return .failure(.folderNotWritable(path: repoRoot.path))
        }
        let relOut = ".code-notes/scan.json"
        let prompt = Self.buildPrompt(outputPath: relOut)
        let args = ["-p", prompt, "--permission-mode", "acceptEdits"]
        do {
            let (exit, _, stderr) = try await launcher.run(
                executable: cliExecutable, arguments: args,
                currentDirectory: repoRoot, environment: nil)
            if exit != 0 {
                return .failure(.scanFailed(message: tail(stderr)))
            }
        } catch is CancellationError {
            return .failure(.cancelled)
        } catch {
            return .failure(.scanFailed(message: error.localizedDescription))
        }

        let outURL = repoRoot.appendingPathComponent(relOut)
        guard let data = try? Data(contentsOf: outURL) else {
            return .failure(.noScanOutput)
        }
        do { return .success(try ScanResult.decode(data)) }
        catch let e as CodeNoteError { return .failure(e) }
        catch { return .failure(.parseFailed(message: error.localizedDescription)) }
    }

    private func tail(_ data: Data) -> String {
        String(data: data.suffix(800), encoding: .utf8) ?? ""
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter ScanPhaseTests 2>&1 | tail -5`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/ScanPhase.swift mac/Tests/MeetNotesMacTests/ScanPhaseTests.swift
git commit -m "feat(codenotes): add ScanPhase (deterministic structure extraction)"
```

---

## Task 10: AnalyzePhase — per-batch prompt, launch agent to write notes

Edges live in each note's frontmatter `links` (the single source of truth,
per the spec). There is no separate edges file — `CodeNoteParser` derives
all edges from note links, and `EdgeRecovery` backstops dropped imports.

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/AnalyzePhase.swift`
- Test: `mac/Tests/MeetNotesMacTests/AnalyzePhaseTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct AnalyzePhaseTests {
    final class MockLauncher: ProcessLauncher, @unchecked Sendable {
        var capturedArgs: [String] = []
        var capturedCwd: URL?
        var exitCode: Int32 = 0
        func run(executable: URL, arguments: [String], currentDirectory: URL?, environment: [String: String]?) async throws -> (Int32, Data, Data) {
            capturedArgs = arguments
            capturedCwd = currentDirectory
            return (exitCode, Data(), Data())
        }
    }

    private func sampleBatch() -> CodeBatch {
        CodeBatch(index: 0, files: ["a.ts"], neighbors: ["a.ts": ["b.ts"]])
    }
    private func sampleScan() -> ScanResult {
        ScanResult(
            files: [.init(path: "a.ts", language: "typescript", loc: 10)],
            imports: ["a.ts": ["b.ts"]],
            symbols: ["a.ts": [.init(name: "foo", kind: "function", line: 3)]])
    }

    @Test func promptIncludesFilesSymbolsNeighborsAndNotesDir() {
        let prompt = AnalyzePhase.buildPrompt(batch: sampleBatch(), scan: sampleScan(),
                                              notesDir: ".code-notes/notes")
        #expect(prompt.contains("a.ts"))
        #expect(prompt.contains("foo"))
        #expect(prompt.contains("b.ts"))        // neighbor
        #expect(prompt.contains(".code-notes/notes"))
        #expect(prompt.contains("imports"))     // import-link instruction
    }

    @Test func runSucceedsOnZeroExitAndSetsCwd() async throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("analyze-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }

        let launcher = MockLauncher()
        let phase = AnalyzePhase(launcher: launcher, cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        let result = await phase.run(batch: sampleBatch(), scan: sampleScan(), repoRoot: repo)
        #expect(result == .success(()))
        #expect(launcher.capturedCwd == repo)
    }

    @Test func runReportsAnalyzeFailedOnNonZeroExit() async {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("analyze-fail-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let launcher = MockLauncher()
        launcher.exitCode = 3
        let phase = AnalyzePhase(launcher: launcher, cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        let result = await phase.run(batch: sampleBatch(), scan: sampleScan(), repoRoot: repo)
        guard case .failure(.analyzeFailed(let batch, _)) = result else {
            Issue.record("expected analyzeFailed, got \(result)"); return
        }
        #expect(batch == 0)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter AnalyzePhaseTests 2>&1 | tail -5`
Expected: FAIL — `AnalyzePhase` not defined.

- [ ] **Step 3: Implement AnalyzePhase.swift**

```swift
import Foundation

/// Phase 3: for one batch, give the agent the structural facts + neighbor
/// context and have it write one markdown note per file. Edges live in the
/// notes' frontmatter `links` — there is no separate edges file.
public final class AnalyzePhase {
    private let launcher: ProcessLauncher
    private let cliExecutable: URL

    public init(launcher: ProcessLauncher, cliExecutable: URL) {
        self.launcher = launcher
        self.cliExecutable = cliExecutable
    }

    public static func buildPrompt(batch: CodeBatch, scan: ScanResult,
                                   notesDir: String) -> String {
        // Compact the structural facts for just this batch's files.
        var facts = ""
        for file in batch.files {
            let syms = (scan.symbols[file] ?? [])
                .map { "\($0.name)(\($0.kind))@L\($0.line)" }.joined(separator: ", ")
            let imps = (scan.imports[file] ?? []).joined(separator: ", ")
            let neigh = (batch.neighbors[file] ?? []).joined(separator: ", ")
            facts += "- \(file)\n    symbols: \(syms.isEmpty ? "(none)" : syms)\n"
            facts += "    imports: \(imps.isEmpty ? "(none)" : imps)\n"
            facts += "    neighbors(other batches): \(neigh.isEmpty ? "(none)" : neigh)\n"
        }

        return """
        You are a code-note writer. You are GIVEN the structural facts below
        (extracted deterministically). Do NOT re-derive structure — only add
        semantic understanding. Do everything with your Write tool NOW; do not
        ask questions or summarize.

        For EACH file below, write one markdown note to
        `\(notesDir)/<file path>.md` with YAML frontmatter. ALL graph edges
        live in the frontmatter `links` — there is no separate edges file.
        ---
        id: file:<relative path>
        kind: file
        title: <file name>
        path: <relative path>
        language: <language>
        complexity: simple|moderate|complex   (under 50 LOC simple, 50-200 moderate, else complex)
        tags: [<3-5 lowercase-hyphenated tags>]
        symbols:
          - {name: <n>, kind: <k>, line: <int>}   (copy from the facts)
        links:
          - {to: file:<imported path>, kind: imports}   (one per import in the facts, VERBATIM)
          - {to: <id>, kind: calls|inherits|tested_by}  (semantic edges you judge)
        ---
        ## Summary
        <1-2 sentence what-it-does, not "contains functions">

        ## Purpose
        <why it exists, how it fits the system>

        ## Key Symbols
        <bullet the important symbols and what they do>

        ## Relationships
        <what it depends on / what uses it>

        Rules:
        - Emit one `imports` link per import listed in the facts — ALL of them.
        - If a file has more than 15 symbols or 400 LOC, ALSO write per-symbol
          sub-notes (id: function:<path>:<name>, kind: function) each with a
          `{to: file:<path>, kind: contains}` link back to the file note.
        - You may reference neighbor files (other batches) as link targets.
        - Ensure each note's YAML is valid: closed brackets, quoted strings,
          no trailing commas. When done writing all files, stop.

        --- STRUCTURAL FACTS (this batch) ---
        \(facts)
        """
    }

    public func run(batch: CodeBatch, scan: ScanResult,
                    repoRoot: URL) async -> Result<Void, CodeNoteError> {
        let notesDir = ".code-notes/notes"
        let prompt = Self.buildPrompt(batch: batch, scan: scan, notesDir: notesDir)
        let args = ["-p", prompt, "--permission-mode", "acceptEdits"]
        do {
            let (exit, _, stderr) = try await launcher.run(
                executable: cliExecutable, arguments: args,
                currentDirectory: repoRoot, environment: nil)
            if exit != 0 {
                return .failure(.analyzeFailed(batch: batch.index, message: tail(stderr)))
            }
            return .success(())
        } catch is CancellationError {
            return .failure(.cancelled)
        } catch {
            return .failure(.analyzeFailed(batch: batch.index, message: error.localizedDescription))
        }
    }

    private func tail(_ data: Data) -> String {
        String(data: data.suffix(800), encoding: .utf8) ?? ""
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter AnalyzePhaseTests 2>&1 | tail -5`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/AnalyzePhase.swift mac/Tests/MeetNotesMacTests/AnalyzePhaseTests.swift
git commit -m "feat(codenotes): add AnalyzePhase (per-batch markdown note generation)"
```

---

## Task 11: CodeNoteService — orchestrator

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/CodeNoteService.swift`
- Test: `mac/Tests/MeetNotesMacTests/CodeNotePipelineIntegrationTests.swift`

- [ ] **Step 1: Write the failing integration test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

@MainActor
struct CodeNotePipelineIntegrationTests {
    /// Mock that simulates the agent for BOTH phases by writing the files
    /// the service expects, based on which prompt it receives.
    final class ScriptedLauncher: ProcessLauncher, @unchecked Sendable {
        let repo: URL
        init(repo: URL) { self.repo = repo }
        func run(executable: URL, arguments: [String], currentDirectory: URL?, environment: [String: String]?) async throws -> (Int32, Data, Data) {
            let prompt = arguments.joined(separator: " ")
            if prompt.contains("code-structure scanner") {
                let dir = repo.appendingPathComponent(".code-notes")
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let json = #"{"files":[{"path":"a.ts","language":"typescript","loc":10},{"path":"b.ts","language":"typescript","loc":8}],"imports":{"a.ts":["b.ts"],"b.ts":[]},"symbols":{"a.ts":[{"name":"foo","kind":"function","line":1}],"b.ts":[]}}"#
                try? json.write(to: dir.appendingPathComponent("scan.json"), atomically: true, encoding: .utf8)
            } else if prompt.contains("code-note writer") {
                let notes = repo.appendingPathComponent(".code-notes/notes")
                try? FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
                // Write a note for a.ts but deliberately OMIT the import link,
                // so EdgeRecovery has to re-add it.
                let aNote = "---\nid: file:a.ts\nkind: file\ntitle: a.ts\npath: a.ts\ntags: [core]\nlinks: []\n---\n## Summary\nEntry point.\n"
                let bNote = "---\nid: file:b.ts\nkind: file\ntitle: b.ts\npath: b.ts\ntags: [util]\nlinks: []\n---\n## Summary\nHelper.\n"
                try? aNote.write(to: notes.appendingPathComponent("a.ts.md"), atomically: true, encoding: .utf8)
                try? bNote.write(to: notes.appendingPathComponent("b.ts.md"), atomically: true, encoding: .utf8)
            }
            return (0, Data(), Data())
        }
    }

    @Test func fullPipelineProducesGraphWithRecoveredImportEdge() async throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pipeline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }

        let service = CodeNoteService(
            launcher: ScriptedLauncher(repo: repo),
            cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        let data = try await service.generate(repoRoot: repo).get()

        #expect(data.nodes.count == 2)
        // The import a.ts -> b.ts was omitted by the "agent" but recovered.
        #expect(data.edges.contains { $0.fromId == "file:a.ts" && $0.toId == "file:b.ts" && $0.kind == .imports })

        // Notes + index written to disk.
        let notesDir = repo.appendingPathComponent(".code-notes/notes")
        #expect(FileManager.default.fileExists(atPath: notesDir.appendingPathComponent("a.ts.md").path))
        #expect(FileManager.default.fileExists(atPath: repo.appendingPathComponent(".code-notes/index.md").path))
        #expect(FileManager.default.fileExists(atPath: repo.appendingPathComponent(".code-notes/fingerprints.json").path))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter CodeNotePipelineIntegrationTests 2>&1 | tail -5`
Expected: FAIL — `CodeNoteService` not defined.

- [ ] **Step 3: Implement CodeNoteService.swift**

```swift
import Foundation
import Combine

/// Orchestrates the 4-phase code-note pipeline. Observable for UI progress.
@MainActor
public final class CodeNoteService: ObservableObject {
    public enum Progress: Equatable {
        case idle
        case scanning
        case analyzing(done: Int, total: Int)
        case deriving
        case done(nodeCount: Int, edgeCount: Int)
        case failed(String)
    }

    @Published public private(set) var progress: Progress = .idle

    private let launcher: ProcessLauncher
    private let cliExecutable: URL
    private let maxBatchSize: Int

    public init(launcher: ProcessLauncher,
                cliExecutable: URL,
                maxBatchSize: Int = 20) {
        self.launcher = launcher
        self.cliExecutable = cliExecutable
        self.maxBatchSize = maxBatchSize
    }

    /// Resolve the active CLI's executable (e.g. `claude`) on PATH.
    public static func resolveCLI(_ tool: AICliTool) -> URL? {
        let name = tool.cliExecutable.split(separator: " ").first.map(String.init) ?? tool.cliExecutable
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let cand = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
                if FileManager.default.isExecutableFile(atPath: cand.path) { return cand }
            }
        }
        for p in ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    public func generate(repoRoot: URL) async -> Result<CGData, CodeNoteError> {
        let codeNotesDir = repoRoot.appendingPathComponent(".code-notes")
        let notesDir = codeNotesDir.appendingPathComponent("notes")

        // Phase 1: SCAN
        progress = .scanning
        let scan: ScanResult
        switch await ScanPhase(launcher: launcher, cliExecutable: cliExecutable).run(repoRoot: repoRoot) {
        case .failure(let e): progress = .failed("\(e)"); return .failure(e)
        case .success(let s): scan = s
        }

        // Phase 2: DIFF + BATCH
        let current = currentHashes(scan: scan, repoRoot: repoRoot)
        let fpURL = codeNotesDir.appendingPathComponent("fingerprints.json")
        let previous = FingerprintStore.load(from: fpURL).hashes
        let classification = Fingerprint.classify(previous: previous, current: current)

        // Remove notes for deleted files.
        for path in classification.deleted {
            try? FileManager.default.removeItem(at: noteURL(notesDir: notesDir, path: path))
        }

        let toAnalyze = classification.changed
        let batches = BatchPlanner.plan(files: toAnalyze, imports: scan.imports, maxBatchSize: maxBatchSize)

        // Phase 3: ANALYZE (sequential here; concurrency is an optimization)
        let analyze = AnalyzePhase(launcher: launcher, cliExecutable: cliExecutable)
        for (i, batch) in batches.enumerated() {
            progress = .analyzing(done: i, total: batches.count)
            switch await analyze.run(batch: batch, scan: scan, repoRoot: repoRoot) {
            case .failure(let e):
                // Surface but continue: a failed batch leaves its files
                // without notes; the rest still produce a usable graph.
                if case .cancelled = e { progress = .failed("\(e)"); return .failure(e) }
            case .success:
                break
            }
        }

        // Phase 4: MERGE + RECOVER + DERIVE
        progress = .deriving
        let notes = loadAllNotes(notesDir: notesDir)
        let recovered = EdgeRecovery.recover(notes: notes, imports: scan.imports)
        // Persist recovered links back to disk so notes stay the source of truth.
        for note in recovered {
            if let path = note.path {
                try? CodeNoteWriter.write(note, to: noteURL(notesDir: notesDir, path: path))
            }
        }
        let data = CodeNoteParser.derive(from: recovered)

        // Write index + fingerprints.
        try? IndexWriter.write(notes: recovered, to: codeNotesDir.appendingPathComponent("index.md"))
        try? FingerprintStore(hashes: current).save(to: fpURL)

        progress = .done(nodeCount: data.nodes.count, edgeCount: data.edges.count)
        return .success(data)
    }

    // MARK: - Helpers

    private func currentHashes(scan: ScanResult, repoRoot: URL) -> [String: String] {
        var out: [String: String] = [:]
        for f in scan.files {
            let url = repoRoot.appendingPathComponent(f.path)
            if let data = try? Data(contentsOf: url) {
                out[f.path] = Fingerprint.hash(of: data)
            }
        }
        return out
    }

    private func noteURL(notesDir: URL, path: String) -> URL {
        notesDir.appendingPathComponent("\(path).md")
    }

    private func loadAllNotes(notesDir: URL) -> [CodeNote] {
        guard let en = FileManager.default.enumerator(at: notesDir,
                includingPropertiesForKeys: nil) else { return [] }
        var notes: [CodeNote] = []
        for case let url as URL in en where url.pathExtension == "md" {
            if let note = try? CodeNoteWriter.read(from: url) { notes.append(note) }
        }
        return notes.sorted { $0.id < $1.id }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mac && swift test --filter CodeNotePipelineIntegrationTests 2>&1 | tail -5`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full test suite**

Run: `cd mac && swift test 2>&1 | tail -15`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeNotes/CodeNoteService.swift mac/Tests/MeetNotesMacTests/CodeNotePipelineIntegrationTests.swift
git commit -m "feat(codenotes): add CodeNoteService orchestrator + full pipeline integration test"
```

---

## Task 12: UI integration + gitignore

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift`
- Modify: `mac/.gitignore`

- [ ] **Step 1: Add `.code-notes/` to gitignore**

In `mac/.gitignore`, add a line after the `.understand-anything/` entry:
```
.code-notes/
```

- [ ] **Step 2: Read UAGraphView to find the Mode enum and run controls**

Run: `cd mac && grep -n 'enum Mode\|case code\|case data\|case memory\|func run\|Button' Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift | head -30`
Expected: locates the `Mode` enum and the existing run button / mode switch you'll extend.

- [ ] **Step 3: Add a `codeNotes` case to the Mode enum**

In the `Mode` enum within `UAGraphView.swift`, add the new case and its display strings alongside the existing ones:

```swift
case codeNotes   // → CodeNoteService generates InfiniteBrain notes + graph
```

Add its label in the same `switch` blocks that map `.code`/`.data`/`.memory` to titles/help (mirror the existing pattern — e.g. title `"Code Notes"`, button `"Generate Code Notes"`, help `"Generate markdown notes + graph for the selected code folder."`).

- [ ] **Step 4: Add a CodeNoteService state + generate action**

Add the service as a `@StateObject` near the other view state (around line 124-141 where `fullData`/`displayData` live):

```swift
@StateObject private var codeNoteService = CodeNoteService(
    launcher: SystemProcessLauncher(),
    cliExecutable: CodeNoteService.resolveCLI(.claudeCode)
        ?? URL(fileURLWithPath: "/usr/bin/false"))
```

Add a generate method that assigns into `fullData` using the **exact** layout call the existing modes use (see `UAGraphView.swift:1251` — `CodeGraphLayout.compute(_:canvasSize:)` with `UAHelpers.layoutSize(for:)`):

```swift
private func generateCodeNotes(target: URL) {
    Task {
        let result = await codeNoteService.generate(repoRoot: target)
        if case .success(let data) = result {
            await MainActor.run {
                self.fullData = CodeGraphLayout.compute(
                    data, canvasSize: UAHelpers.layoutSize(for: data.nodes.count))
            }
        }
    }
}
```

Assigning `fullData` triggers the existing `.onChange(of: fullData)` → `recomputeDisplayData()` (line 422), which feeds `CodeGraphCanvas`. No new rendering wiring needed — this matches exactly how `.code` mode populates the canvas at line 1251.

- [ ] **Step 5: Render progress + wire the button for `.codeNotes` mode**

In the run-controls area, when `mode == .codeNotes`, show a button that calls `generateCodeNotes(target:)` and a progress line driven by `codeNoteService.progress`:

```swift
switch codeNoteService.progress {
case .idle:                       EmptyView()
case .scanning:                   Text("Scanning…")
case .analyzing(let d, let t):    Text("Analyzing \(d) of \(t) batches…")
case .deriving:                   Text("Deriving graph…")
case .done(let n, let e):         Text("\(n) nodes · \(e) edges")
case .failed(let msg):            Text(msg).foregroundStyle(.red)
}
```

- [ ] **Step 6: Build**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!` (fix property-name mismatches against the real `UAGraphView` graph state).

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift mac/.gitignore
git commit -m "feat(ui): add Code Notes mode to the graph view + gitignore .code-notes/"
```

---

## Task 13: Full verification — build, test, app bundle, launch

- [ ] **Step 1: Full debug build**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 2: Run the complete test suite**

Run: `cd mac && swift test 2>&1 | tail -20`
Expected: all tests pass (Fingerprint, BatchPlanner, CodeNoteWriter, CodeNoteParser, EdgeRecovery, IndexWriter, ScanPhase, AnalyzePhase, CodeNotePipelineIntegration + the pre-existing suite).

- [ ] **Step 3: Build the app bundle**

Run: `cd mac && bash Scripts/build.sh 2>&1 | tail -3`
Expected: `[build] ok — …/MeetNotesMac.app`

- [ ] **Step 4: Launch and smoke-test**

Run: `pkill -9 MeetNotesMac 2>/dev/null; sleep 1; open mac/MeetNotesMac.app`
Verify: open a project → Code Graph section → switch to **Code Notes** mode → click **Generate Code Notes**. With an AI CLI installed it runs the pipeline (Scanning → Analyzing → Deriving) and renders the graph; the `.code-notes/notes/` folder fills with `.md` files. Without a CLI it surfaces the install hint without crashing.

- [ ] **Step 5: Final commit + push**

```bash
git add -A
git commit -m "chore: code notes & graph system complete" --allow-empty
git push origin main
```
