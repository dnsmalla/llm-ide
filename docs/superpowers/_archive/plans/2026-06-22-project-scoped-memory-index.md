# Project-scoped Memory Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent's project memory and the "All" graph a real combination of the separately-built code and doc indexes — by writing doc content into the on-disk memory artifact and having "All" combine the two indexes instead of re-scanning.

**Architecture:** The code index (`system/graph/`, on disk) and doc index (in-session, fingerprint-cached) already exist. This adds a `doc-notes.md` to the project's `graphify-out/memory/` so the combined "memory index" the agent reads contains doc content; teaches the extension reader to consume it; and makes the view's "All" reuse the cached code+doc indexes rather than regenerate.

**Tech Stack:** Swift (macOS app, `KnowledgeGraphService`, `UAGraphView`), GraphKit (`MemoryGenerator`, `CGData`), Node.js ESM (extension `graphkit/memory.mjs`). Tests: XCTest (`swift test`), node:test (`npm test`).

**Spec:** `docs/superpowers/specs/2026-06-22-project-scoped-memory-index-design.md`

---

### Task 1: `renderDocNotes` — doc graph → markdown

Render the doc/InfiniteBrain content as markdown for the memory artifact. Pure, nonisolated static so it's unit-testable (like the existing `renderGraphNotes`).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift` (add static func next to `renderGraphNotes`)
- Test: `mac/Tests/LlmIdeMacTests/DocNotesRenderTests.swift` (create)

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/DocNotesRenderTests.swift`:

```swift
import XCTest
import GraphKit
@testable import LlmIdeMac

/// renderDocNotes turns the doc index into the markdown that becomes
/// graphify-out/memory/doc-notes.md — the doc half of the combined memory.
final class DocNotesRenderTests: XCTestCase {
    func testRenderDocNotesGroupsChunksByDocAndListsHeadings() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("docnotes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let md = dir.appendingPathComponent("Guide.md")
        try "# Setup\nInstall it.\n\n# Usage\nRun it.\n".write(to: md, atomically: true, encoding: .utf8)

        // Build real chunks via MemoryGenerator (MemoryChunk has no public init).
        let mem = MemoryGenerator.generate(files: [md])
        let out = KnowledgeGraphService.renderDocNotes(docCount: mem.docCount, chunks: mem.chunks)

        XCTAssertTrue(out.contains("Guide"), "doc title should appear")
        XCTAssertTrue(out.contains("Setup"), "heading should appear")
        XCTAssertTrue(out.contains("Usage"), "heading should appear")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter DocNotesRenderTests 2>&1 | tail -15`
Expected: FAIL — compile error `type 'KnowledgeGraphService' has no member 'renderDocNotes'`.

- [ ] **Step 3: Write minimal implementation**

In `mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift`, add immediately after the closing brace of `renderGraphNotes(...)`:

```swift
    /// Render `doc-notes.md`: the doc/InfiniteBrain content for the combined
    /// memory the agent reads — docs grouped by title, each listing its chunk
    /// headings. This is the doc half that the memory artifact previously omitted.
    nonisolated static func renderDocNotes(docCount: Int, chunks: [MemoryChunk]) -> String {
        var out = "# Documentation memory\n\n"
        out += "\(docCount) document\(docCount == 1 ? "" : "s") · "
        out += "\(chunks.count) section\(chunks.count == 1 ? "" : "s").\n\n"
        let byDoc = Dictionary(grouping: chunks, by: \.docTitle)
        for docTitle in byDoc.keys.sorted() {
            out += "## \(docTitle)\n"
            for chunk in byDoc[docTitle] ?? [] {
                out += "- \(chunk.displayHeading)\n"
            }
            out += "\n"
        }
        return out
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter DocNotesRenderTests 2>&1 | tail -8`
Expected: PASS — `Executed 1 test, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift mac/Tests/LlmIdeMacTests/DocNotesRenderTests.swift
git commit -m "feat(mac): renderDocNotes — doc index as markdown for combined memory" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `writeMemoryArtifact` writes `doc-notes.md`

Extend the artifact writer to emit the doc half. New parameters carry the doc count + chunks.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift` (`writeMemoryArtifact` signature + body)
- Test: `mac/Tests/LlmIdeMacTests/DocNotesRenderTests.swift` (add a test)

- [ ] **Step 1: Write the failing test**

Add to `DocNotesRenderTests`:

```swift
    func testWriteMemoryArtifactWritesDocNotes() throws {
        let repoRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("memart-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repoRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repoRoot) }
        let md = repoRoot.appendingPathComponent("Guide.md")
        try "# Setup\nInstall it.\n".write(to: md, atomically: true, encoding: .utf8)
        let mem = MemoryGenerator.generate(files: [md])

        KnowledgeGraphService.writeMemoryArtifact(
            to: repoRoot, code: .empty, doc: mem.graph, merged: mem.graph,
            docCount: mem.docCount, chunks: mem.chunks)

        let docNotes = repoRoot
            .appendingPathComponent("graphify-out/memory/doc-notes.md")
        let content = try String(contentsOf: docNotes, encoding: .utf8)
        XCTAssertTrue(content.contains("Guide"), "doc-notes.md should contain doc content")
        XCTAssertTrue(content.contains("Setup"))
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter DocNotesRenderTests 2>&1 | tail -15`
Expected: FAIL — compile error: `writeMemoryArtifact` does not accept `docCount:`/`chunks:` (extra arguments).

- [ ] **Step 3: Write minimal implementation**

In `KnowledgeGraphService.swift`, change the `writeMemoryArtifact` signature from:

```swift
    nonisolated static func writeMemoryArtifact(to repoRoot: URL, code: CGData, doc: CGData, merged: CGData) {
```

to:

```swift
    nonisolated static func writeMemoryArtifact(to repoRoot: URL, code: CGData, doc: CGData, merged: CGData,
                                                docCount: Int, chunks: [MemoryChunk]) {
```

Then, inside the `do { ... }` block that writes `repo.md` and `graph-notes.md`, add a third write after the `graph-notes.md` line:

```swift
            try renderDocNotes(docCount: docCount, chunks: chunks)
                .write(to: memDir.appendingPathComponent("doc-notes.md"), atomically: true, encoding: .utf8)
```

(It sits next to the existing `repo.md` / `graph-notes.md` writes, inside the same `do`/`catch` so a write failure is logged, not fatal.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter DocNotesRenderTests 2>&1 | tail -8`
Expected: PASS — `Executed 2 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift mac/Tests/LlmIdeMacTests/DocNotesRenderTests.swift
git commit -m "feat(mac): writeMemoryArtifact emits doc-notes.md (doc half of memory)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Pass doc chunks/count from `runOnce` to the artifact writer

Wire the live doc data into the (now-extended) writer.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift` (`runOnce`, the `if let memoryRoot { ... }` block)

- [ ] **Step 1: Update the call site**

In `runOnce`, replace the memory-artifact block:

```swift
        if let memoryRoot {
            let code = codeGraph, docData = docGraph, mg = mergedGraph
            await Task.detached(priority: .utility) {
                Self.writeMemoryArtifact(to: memoryRoot, code: code, doc: docData, merged: mg)
            }.value
        }
```

with (capture the doc chunks + count alongside the graphs):

```swift
        if let memoryRoot {
            let code = codeGraph, docData = docGraph, mg = mergedGraph
            let chunks = doc.chunks, dCount = doc.docCount
            await Task.detached(priority: .utility) {
                Self.writeMemoryArtifact(to: memoryRoot, code: code, doc: docData, merged: mg,
                                         docCount: dCount, chunks: chunks)
            }.value
        }
```

(`doc` is the local `(graph, chunks, docCount)` tuple already in scope in `runOnce`; `[MemoryChunk]` and `Int` are `Sendable`, so the detached capture is safe.)

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build 2>&1 | tail -4`
Expected: `Build complete!`

- [ ] **Step 3: Run the full Mac suite to confirm no regression**

Run: `cd mac && swift test 2>&1 | tail -6`
Expected: all tests pass (0 failures).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift
git commit -m "feat(mac): feed doc chunks/count into the memory artifact write" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Extension reader consumes `doc-notes.md`

Add `doc-notes.md` to the memory reader's allow-list so the agent's "Repository memory" includes the doc half.

**Files:**
- Modify: `extension/graphkit/memory.mjs` (the per-repo block, next to the `repo.md` / `graph-notes.md` `tryAdd` calls)
- Test: `extension/tests/graphify-memory-doc-notes.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `extension/tests/graphify-memory-doc-notes.test.mjs`:

```javascript
// doc-notes.md (the doc half of the combined memory index, written by the Mac
// app) must be surfaced in the agent's "Repository memory" block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-docnotes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { renderGraphifyMemory } = await import('../graphkit/memory.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function freshUser(tag) {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

test('renderGraphifyMemory includes doc-notes.md content', () => {
  const U = freshUser('dn');
  const repoAbs = path.join(__dirname, `_graphify-docnotes-repo-${Date.now()}`);
  const memDir = path.join(repoAbs, 'graphify-out', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'doc-notes.md'), '# Documentation memory\n## Guide\n- Setup');
  try {
    db.addUserRepo(U, repoAbs);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'dn' }] }, U);
    assert.match(out, /Documentation memory/);
    assert.match(out, /Guide/);
  } finally {
    db.closeDb();
    for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/graphify-memory-doc-notes.test.mjs 2>&1 | tail -15`
Expected: FAIL — the assertion `out` does not contain "Documentation memory" (reader doesn't read `doc-notes.md` yet).

- [ ] **Step 3: Write minimal implementation**

In `extension/graphkit/memory.mjs`, find the line:

```javascript
  tryAdd('graph-notes.md', safeRead(join(memDir, 'graph-notes.md'), PER_FILE_CHARS));
```

Add immediately after it:

```javascript
  tryAdd('doc-notes.md', safeRead(join(memDir, 'doc-notes.md'), PER_FILE_CHARS));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/graphify-memory-doc-notes.test.mjs 2>&1 | tail -8`
Expected: PASS — `pass 1`, `fail 0`.

- [ ] **Step 5: Run the full extension suite (no regression)**

Run: `cd extension && npm test 2>&1 | tail -8`
Expected: all pass (`fail 0`).

- [ ] **Step 6: Commit**

```bash
git add extension/graphkit/memory.mjs extension/tests/graphify-memory-doc-notes.test.mjs
git commit -m "feat(extension): surface doc-notes.md in agent Repository memory" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: "All" combines the cached code + doc indexes (no re-scan)

Make `generateAll` reuse the cached doc index when its fingerprint is unchanged, mirroring the existing code-graph reuse — so "All" combines the two separately-built indexes instead of re-running `MemoryGenerator`.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeGraph/UAGraphView.swift` (`generateAll`)

- [ ] **Step 1: Replace `generateAll` with the reuse-aware version**

Replace the current `generateAll()` body (the `runTask = Task { ... }` that always calls `MemoryGenerator.generate(from: repo)`) with:

```swift
    private func generateAll() {
        guard let repo = activeRepoRoot else { return }
        status = .running
        // Reuse the cached doc index when its fingerprint is unchanged, so "All"
        // combines the already-built code + doc indexes instead of re-scanning
        // the docs. (Code reuse is handled below via the cache fallback.)
        let docFp = KnowledgeGraphService.docSetFingerprint(roots: [repo])
        let cachedDoc = graphSessionStore.entry(repo: activeRepoRoot, mode: Mode.data.rawValue)
        let reusedDoc: (graph: CGData, chunks: [MemoryChunk], docs: Int)? =
            (cachedDoc?.docFingerprint == docFp && !(cachedDoc?.graph.nodes.isEmpty ?? true))
            ? (cachedDoc!.graph, cachedDoc!.chunks, cachedDoc!.docCount)
            : nil
        runTask = Task {
            _ = await codeNoteService.generate(repoRoot: repo)
            if Task.isCancelled { return }
            // "md is doc": strip code-track markdown so it isn't merged twice.
            var code = FileClassifier.strippingDocNodes(from: codeNoteService.graph)
            var codeFromCache = false
            if code.nodes.isEmpty, let cachedCode = cachedGraph(.code), !cachedCode.nodes.isEmpty {
                code = cachedCode   // already markdown-free (stripped when cached)
                codeFromCache = true
            }
            let result = await Task.detached(priority: .userInitiated) { () -> (data: CGData, chunks: [MemoryChunk], docs: Int) in
                let doc: (graph: CGData, chunks: [MemoryChunk], docs: Int)
                if let reusedDoc {
                    doc = reusedDoc                                   // combine the cached doc index
                } else {
                    let docMem = MemoryGenerator.generate(from: repo) // build it if not fresh
                    doc = (docMem.graph, docMem.chunks, docMem.docCount)
                }
                let merged = KnowledgeGraphService.merge(code: code, doc: doc.graph, chunks: doc.chunks)
                let laid = CodeGraphLayout.compute(merged, canvasSize: CGSize(width: 1200, height: 800))
                return (laid, doc.chunks, doc.docs)
            }.value
            if Task.isCancelled { return }
            // Generation telemetry (mirrors KnowledgeGraphService's count log):
            // records the code/doc contributions to the merged "All" graph, which
            // also pinpoints a code-vs-doc shortfall if the graph ever looks short.
            Self.log.info("generateAll[\(repo.lastPathComponent, privacy: .public)]: code=\(code.nodes.count, privacy: .public)\(codeFromCache ? " (cache)" : "", privacy: .public)\(reusedDoc != nil ? " doc(cache)" : "", privacy: .public) docFiles=\(result.docs, privacy: .public) docChunks=\(result.chunks.count, privacy: .public) merged=\(result.data.nodes.count, privacy: .public)")
            self.selectedNode = nil
            self.memoryChunks = result.chunks
            self.memoryDocCount = result.docs
            self.fullData = result.data
            self.cacheGraph(.all, result.data, chunks: result.chunks, docCount: result.docs)
            self.status = .loaded(nodeCount: result.data.nodes.count, edgeCount: result.data.edges.count)
            self.settlePhysics(from: result.data, expectedMode: .all)
        }
    }
```

(`reusedDoc` is `(CGData, [MemoryChunk], Int)?` — all `Sendable` — so capturing it in the detached closure is safe. The cached `.data` graph may be laid-out, but `merge()` only unions nodes by id and `CodeGraphLayout.compute` re-positions the merged result, so reusing it is correct.)

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build 2>&1 | tail -4`
Expected: `Build complete!`

- [ ] **Step 3: Run the full Mac suite (no regression)**

Run: `cd mac && swift test 2>&1 | tail -6`
Expected: all tests pass (0 failures).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeGraph/UAGraphView.swift
git commit -m "feat(mac): All combines cached code+doc indexes instead of re-scanning" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Runtime verification (user) + cleanup

The Mac GUI can't be driven headlessly; the user verifies behavior in the real app.

- [ ] **Step 1: User runs the app and confirms**
  - Generate (or open) the graph for a project with `.md` docs.
  - Agent "Repository memory" now includes a "Documentation memory" section (from `doc-notes.md`).
  - "All" shows code + docs; the `generateAll[...]` log shows `doc(cache)` on a second run with unchanged docs (reuse, no re-scan).
- [ ] **Step 2: If all confirmed, the telemetry log may stay (it mirrors `KnowledgeGraphService`'s count log).** No further cleanup required.

---

## Self-Review

- **Spec coverage:** doc content in memory → Tasks 1–4; "All" combines indexes (reuse) → Task 5; project-scoped paths (`graphify-out/memory/`, derived from repo root) → Tasks 2–3; cross-subsystem reader contract → Task 4; in-session doc index (no disk persistence) → honored (no doc-index.json task). ✔
- **Placeholders:** none — every code step shows the actual code; every run step shows the command + expected output. ✔
- **Type consistency:** `renderDocNotes(docCount:chunks:)` defined in Task 1, called identically in Tasks 2 and (via `writeMemoryArtifact`) 3; `writeMemoryArtifact(...docCount:chunks:)` signature defined in Task 2, called with the same labels in Task 3; `docSetFingerprint(roots:)`, `merge(code:doc:chunks:)`, `strippingDocNodes(from:)`, `cacheGraph(_:_:chunks:docCount:)`, and `GraphSessionStore.Entry.docFingerprint` all match the current codebase. ✔
