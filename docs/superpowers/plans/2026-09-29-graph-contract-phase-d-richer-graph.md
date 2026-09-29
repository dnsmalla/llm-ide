# Graph as Contract — Phase D (Richer Graph) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the code graph carry what the LLM needs instead of opening files — signatures, parent-qualified methods, real (inferred) call edges, a cache that notices extractor changes and new files — and let the server tell the model when the graph is stale.

**Architecture:** Tasks D0–D4 change graph-kit (`mac/LocalPackages/graph-kit`, its own git repo, branch `feat/phase-d-graph`, LOCAL commits only — nothing is pushed). The regex extractor keeps each symbol's declaration, attributes functions to the enclosing type by indentation (kind `method`, id `method:<path>:<Parent>.<name>`), and emits per-line call references that the builder resolves same-file → imported files → globally-unique name (ambiguous names are skipped). D5–D6 change llm-ide (branch `feat/graph-contract-phase-d`): the Mac uploads the repo's HEAD commit with the graph, the server stores it (`code_graph_meta`, migration 0036) and `find-code` reports `staleGraph` when HEAD has moved; the Mac's code notes list every type kind and methods.

**Tech Stack:** Swift 6 toolchain (Swift 5 mode), XCTest; Node 20+ ESM, better-sqlite3, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-29-graph-as-contract-design.md` (Phase D row). Rulings: tree-sitter bundling and SCIP-by-default are OUT (a Python wheel / external CLI dependency); inferred call edges from the regex extractor are the in-scope substitute. Nothing is pushed; the app keeps building graph-kit `f3151c3` from GitHub until the user pushes and both pins are bumped, so D0–D4 are verified in graph-kit itself and, at the end, against the app via a temporary `swift package edit` override that is undone.

## Global Constraints

- graph-kit: `cd mac/LocalPackages/graph-kit && swift build`, `swift test` (after D0), `swift run -c release graph-engine-lab` and `swift run -c release graph-layout-lab --compare` must pass (both print `PASS`). All SwiftPM commands run unsandboxed.
- graph-kit commits go on branch `feat/phase-d-graph` in `mac/LocalPackages/graph-kit`; never push; never touch its `main`.
- llm-ide: extension module boundaries ESLint-enforced at zero violations; `kb` helpers userId-first + `requireUser`; append-only migrations (update `CLAUDE.md` and the docs pages that name the migration head, as docs-check requires); `cd extension && npm run lint` and `make docs-check` pass.
- No new HTTP endpoint. `commitSha`/`generatedAt` on `/kb/ingest-code-graph` are optional additive body fields; `staleGraph` is an optional additive find-code result field; `SERVER_API_VERSION` (57) is NOT bumped.
- Mac tests ALWAYS `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test …` unsandboxed; `bash mac/Scripts/feature-boundaries.sh` exits 0.
- Conventional Commits, one concern per commit, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| Repo | File | Change |
|---|---|---|
| graph-kit | `Tests/GraphKitTests/*.swift` | D0: add `import GraphCore` / `@testable import GraphKit` so the target compiles |
| graph-kit | `Sources/GraphKit/Scan/FileStructureExtractor.swift` | D1 declaration kept; D2 parent by indentation; D3 call refs |
| graph-kit | `Sources/GraphKit/Build/StructureGraphBuilder.swift` | D2 method ids; D3 call resolution |
| graph-kit | `Sources/GraphKit/Cache/ScanCache.swift`, `Sources/GraphKit/Scan/StructureScanner.swift` | D4 versioned cache, untracked files |
| llm-ide | `extension/kb/migrations/0036_code_graph_meta.sql`, `extension/kb/code-graph.mjs`, `extension/kb/db.mjs`, `extension/connectors/structure-graph.mjs`, `extension/routes/router.mjs`, `extension/llm_agent/runtime/handlers/find-code.mjs`, `mac/.../LlmIdeAPIClient+CodeGraph.swift`, `mac/.../CodeGraphUploadService.swift` | D5 freshness |
| llm-ide | `mac/Sources/LlmIdeMac/Features/CodeGraph/Notes/CodeNoteGenerator.swift` | D6 notes list all kinds |

---

### Task D0: graph-kit test target compiles again

**Files:** Modify every file under `mac/LocalPackages/graph-kit/Tests/GraphKitTests/` that fails to compile.

- [ ] **Step 1: See the failures** — `cd mac/LocalPackages/graph-kit && swift build --build-tests 2>&1 | /usr/bin/grep error: | sort | uniq -c | sort -rn | head -30` (unsandboxed). Expected: `cannot find 'ScanResult'/'CGNodeKind'/'GraphDocument' in scope`, `cannot find 'SystemProcessLauncher'`: the types moved to the `GraphCore` product in the GraphCore/GraphKit split; tests still `import GraphKit` only.
- [ ] **Step 2: Fix imports only** — add `import GraphCore` to each failing test file; where a test uses a GraphKit type that is `internal` (e.g. `SystemProcessLauncher` if not public), change `import GraphKit` to `@testable import GraphKit`. Do NOT change test logic or assertions. If a failure remains that is not an import/visibility problem, report it (NEEDS_CONTEXT) instead of editing the test's behaviour.
- [ ] **Step 3: Run** — `swift test > "$TMPDIR/gk-d0.log" 2>&1; tail -5 "$TMPDIR/gk-d0.log"` and `/usr/bin/grep -E "Executed [0-9]+ tests" "$TMPDIR/gk-d0.log" | tail -1`. Record the pass/fail count. If some tests FAIL at runtime (not compile), list them in the report as pre-existing and mark each with `XCTSkip("pre-existing failure after the GraphCore split — see Phase D ledger")` at the top of that test ONLY if it is unrelated to the extractor/builder/cache (D1–D4 will need extractor/builder tests to be green); otherwise report them.
- [ ] **Step 4: Commit** (in graph-kit):

```bash
cd mac/LocalPackages/graph-kit && git add Tests/GraphKitTests
git commit -m "test: import GraphCore so the test target compiles after the split

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task D1: the regex extractor keeps each symbol's declaration

**Files:** Modify `Sources/GraphKit/Scan/FileStructureExtractor.swift` (`parseFiles`, the `if var sym = Self.symbol(...)` block). Test: `Tests/GraphKitTests/RegexExtractorTests.swift` (create).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
import GraphCore
@testable import GraphKit

/// The regex extractor (Swift/TS/JS/Kotlin) computed a declaration and then
/// rebuilt every symbol without it, so the graph never carried a signature.
final class RegexExtractorTests: XCTestCase {
    func parse(_ files: [String: String]) throws -> [RawFileStructure] {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gk-regex-\(UUID().uuidString)", isDirectory: true)
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return FileStructureExtractor().parseFiles(paths: files.keys.sorted(), repoRoot: root)
    }

    func testDeclarationIsKept() throws {
        let out = try parse(["a.swift": "func rotatePin(for id: String) -> Bool {\n    true\n}\n"])
        let sym = try XCTUnwrap(out.first?.symbols.first { $0.name == "rotatePin" })
        XCTAssertEqual(sym.declaration, "func rotatePin(for id: String) -> Bool")
        XCTAssertEqual(sym.line, 1)
    }
}
```

(If `FileStructureExtractor`'s initializer takes arguments, construct it the way `StructureScanner` does — read `StructureScanner.swift` for the call — and keep the rest of the test as written.)

- [ ] **Step 2: Run to verify failure** — `swift test --filter RegexExtractorTests` — Expected: FAIL (`declaration` is nil).
- [ ] **Step 3: Implement** — replace

```swift
                    if var sym = Self.symbol(fromLine: line, language: lang) {
                        sym = ScanResult.Symbol(name: sym.name, kind: sym.kind, line: idx + 1)
                        symbols.append(sym)
                    }
```

with

```swift
                    if let found = Self.symbol(fromLine: line, language: lang) {
                        // Keep the declaration: it is the signature the server
                        // uploads as `doc`, so the model can skip opening the file.
                        symbols.append(ScanResult.Symbol(name: found.name, kind: found.kind,
                                                         line: idx + 1,
                                                         declaration: found.declaration))
                    }
```

- [ ] **Step 4: Run** — `swift test --filter RegexExtractorTests`, then `swift test` and both labs. Expected: PASS (labs `PASS`).
- [ ] **Step 5: Commit**

```bash
git add Sources/GraphKit/Scan/FileStructureExtractor.swift Tests/GraphKitTests/RegexExtractorTests.swift
git commit -m "fix: keep symbol declarations in the regex extractor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task D2: methods get their parent type and a parent-qualified id

**Files:** Modify `FileStructureExtractor.swift` (`parseFiles`), `Sources/GraphKit/Build/StructureGraphBuilder.swift` (symbol id). Test: append to `RegexExtractorTests.swift`; add `Tests/GraphKitTests/StructureGraphBuilderMethodTests.swift`.

**Interfaces:** Produces symbols with `kind: "method"`, `parent: <TypeName>` for a function declared at greater indentation than the nearest open type declaration; builder ids `method:<path>:<Parent>.<name>`.

- [ ] **Step 1: Write the failing tests**

Append to `RegexExtractorTests`:

```swift
    func testFunctionsInsideATypeBecomeMethodsOfIt() throws {
        let src = """
        struct Alpha {
            func load() {}
        }
        struct Beta {
            func load() {}
        }
        func free() {}
        """
        let syms = try XCTUnwrap(try parse(["f.swift": src]).first?.symbols)
        let loads = syms.filter { $0.name == "load" }
        XCTAssertEqual(loads.map(\.kind), ["method", "method"])
        XCTAssertEqual(loads.map(\.parent), ["Alpha", "Beta"])
        let free = try XCTUnwrap(syms.first { $0.name == "free" })
        XCTAssertEqual(free.kind, "function")
        XCTAssertNil(free.parent)
    }
```

`StructureGraphBuilderMethodTests.swift`:

```swift
import XCTest
import GraphCore
@testable import GraphKit

/// Same-name methods in different types of one file used to share an id
/// (`function:f.swift:load`), so the second was dropped from the graph.
final class StructureGraphBuilderMethodTests: XCTestCase {
    func testSameNameMethodsInDifferentTypesAreBothKept() {
        let syms: [ScanResult.Symbol] = [
            .init(name: "Alpha", kind: "struct", line: 1),
            .init(name: "load", kind: "method", line: 2, parent: "Alpha"),
            .init(name: "Beta", kind: "struct", line: 4),
            .init(name: "load", kind: "method", line: 5, parent: "Beta"),
        ]
        let scan = ScanResult(files: [.init(path: "f.swift", language: "swift", loc: 6)],
                              symbols: ["f.swift": syms], imports: [:],
                              calls: [:], inherits: [:], implements: [:])
        let graph = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r"))
        let ids = Set(graph.nodes.map(\.id))
        XCTAssertTrue(ids.contains("method:f.swift:Alpha.load"))
        XCTAssertTrue(ids.contains("method:f.swift:Beta.load"))
        XCTAssertTrue(graph.edges.contains { $0.fromId == "class:f.swift:Alpha" && $0.toId == "method:f.swift:Alpha.load" && $0.kind == .contains })
    }
}
```

(Construct `ScanResult` and its file entry with whatever initializer `GraphCore/Model/ScanResult.swift` actually declares — read it first; keep the assertions as written.)

- [ ] **Step 2: Run to verify failure** — `swift test --filter "RegexExtractorTests|StructureGraphBuilderMethodTests"` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `parseFiles`, before the line loop, add:

```swift
            // Enclosing-type tracking by indentation (the regex extractor has no
            // scope information). A function declared deeper than the nearest open
            // type declaration is that type's method. Conventional formatting is
            // enough for Swift/Kotlin/TS; a mis-indented file just yields
            // top-level functions, which is today's behaviour.
            let typeKinds: Set<String> = ["class", "struct", "enum", "protocol", "extension", "interface"]
            var typeStack: [(indent: Int, name: String)] = []
            func indentOf(_ s: String) -> Int {
                var n = 0
                for ch in s { if ch == " " { n += 1 } else if ch == "\t" { n += 4 } else { break } }
                return n
            }
```

and replace the D1 block with:

```swift
                    if let found = Self.symbol(fromLine: line, language: lang) {
                        let indent = indentOf(line)
                        while let top = typeStack.last, top.indent >= indent { typeStack.removeLast() }
                        var kind = found.kind
                        var parent: String? = nil
                        if kind == "function", let top = typeStack.last {
                            kind = "method"
                            parent = top.name
                        }
                        symbols.append(ScanResult.Symbol(name: found.name, kind: kind, line: idx + 1,
                                                         declaration: found.declaration, parent: parent))
                        if typeKinds.contains(found.kind) { typeStack.append((indent, found.name)) }
                    }
```

In `StructureGraphBuilder.swift`, replace the symbol id line

```swift
                let id = "\(prefix):\(f.path):\(sym.name)"
```

with

```swift
                // Methods are qualified by their parent so two types in one file
                // can both have a `load()`; everything else keeps its old id.
                let qualified = sym.kind == "method" && sym.parent != nil ? "\(sym.parent!).\(sym.name)" : sym.name
                let id = "\(prefix):\(f.path):\(qualified)"
```

- [ ] **Step 4: Run** — the two filtered suites, then `swift test` and both labs. If a lab or existing test asserted the old method id format, update it to the new format and name it in the report.
- [ ] **Step 5: Commit**

```bash
git add Sources/GraphKit/Scan/FileStructureExtractor.swift Sources/GraphKit/Build/StructureGraphBuilder.swift Tests/GraphKitTests
git commit -m "feat: attribute functions to their enclosing type and qualify method ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task D3: inferred call edges from the regex extractor

**Files:** Modify `FileStructureExtractor.swift` (`parseFiles`: emit `calls`), `StructureGraphBuilder.swift` (calls section). Tests: append to `RegexExtractorTests.swift` and `StructureGraphBuilderMethodTests.swift`.

**Interfaces:** `RawFileStructure.calls` gets `CallRef(caller: <enclosing callable key>, callee: <identifier>, line:)`, where the caller key is `name` for a function and `Parent.name` for a method. The builder emits `calls` edges (confidence `.inferred`) resolving the callee same-file → files this file imports → globally-unique name; an ambiguous callee at any stage is skipped.

- [ ] **Step 1: Write the failing tests**

Append to `RegexExtractorTests`:

```swift
    func testCallsAreAttributedToTheEnclosingCallable() throws {
        let src = """
        func helper() -> Int { 1 }
        func run() {
            let x = helper()
            if x > 0 { print(x) }
        }
        """
        let calls = try XCTUnwrap(try parse(["a.swift": src]).first?.calls)
        XCTAssertTrue(calls.contains { $0.caller == "run" && $0.callee == "helper" })
        XCTAssertFalse(calls.contains { $0.callee == "if" }, "keywords are not calls")
    }
```

Append to `StructureGraphBuilderMethodTests`:

```swift
    func testCallEdgesResolveSameFileThenImportsThenUniqueNames() {
        let files: [ScanResult.File] = ["a.swift", "b.swift", "c.swift", "d.swift"].map {
            .init(path: $0, language: "swift", loc: 3)
        }
        let symbols: [String: [ScanResult.Symbol]] = [
            "a.swift": [.init(name: "helper", kind: "function", line: 1), .init(name: "run", kind: "function", line: 2)],
            "b.swift": [.init(name: "other", kind: "function", line: 1)],
            "c.swift": [.init(name: "load", kind: "function", line: 1)],
            "d.swift": [.init(name: "load", kind: "function", line: 1), .init(name: "caller", kind: "function", line: 2)],
        ]
        let calls: [String: [ScanResult.CallRef]] = [
            "a.swift": [.init(caller: "run", callee: "helper", line: 3)],
            "b.swift": [.init(caller: "other", callee: "helper", line: 2)],   // globally unique
            "d.swift": [.init(caller: "caller", callee: "load", line: 3)],    // same file wins over c.swift
        ]
        let scan = ScanResult(files: files, symbols: symbols, imports: [:],
                              calls: calls, inherits: [:], implements: [:])
        let edges = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r")).edges
            .filter { $0.kind == .calls }
        let pairs = Set(edges.map { "\($0.fromId)>\($0.toId)" })
        XCTAssertTrue(pairs.contains("function:a.swift:run>function:a.swift:helper"))
        XCTAssertTrue(pairs.contains("function:b.swift:other>function:a.swift:helper"))
        XCTAssertTrue(pairs.contains("function:d.swift:caller>function:d.swift:load"))
        XCTAssertFalse(pairs.contains("function:d.swift:caller>function:c.swift:load"))
        XCTAssertTrue(edges.allSatisfy { $0.confidence == .inferred })
    }

    func testAmbiguousCalleeIsSkipped() {
        let files: [ScanResult.File] = ["x.swift", "y.swift", "z.swift"].map { .init(path: $0, language: "swift", loc: 2) }
        let scan = ScanResult(files: files,
                              symbols: ["x.swift": [.init(name: "save", kind: "function", line: 1)],
                                        "y.swift": [.init(name: "save", kind: "function", line: 1)],
                                        "z.swift": [.init(name: "go", kind: "function", line: 1)]],
                              imports: [:],
                              calls: ["z.swift": [.init(caller: "go", callee: "save", line: 2)]],
                              inherits: [:], implements: [:])
        let calls = StructureGraphBuilder.build(scan, repoRoot: URL(fileURLWithPath: "/r")).edges.filter { $0.kind == .calls }
        XCTAssertTrue(calls.isEmpty, "two files define save and z imports neither — no guess")
    }
```

(Match `ScanResult`/`ScanResult.File` initializers to their real declarations.)

- [ ] **Step 2: Run to verify failure** — `swift test --filter "RegexExtractorTests|StructureGraphBuilderMethodTests"` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `FileStructureExtractor`, add statics:

```swift
    /// Identifiers followed by `(` that are language keywords, not calls.
    static let nonCallKeywords: Set<String> = [
        "if", "for", "while", "switch", "return", "guard", "catch", "func", "function", "init",
        "super", "self", "Self", "typeof", "await", "try", "case", "throw", "new", "sizeof",
        "fun", "when", "print", "assert", "precondition", "fatalError",
    ]
    static let callRegex = try! NSRegularExpression(pattern: #"\b([A-Za-z_][A-Za-z0-9_]*)\s*\("#)
    static let maxCallsPerFile = 500
```

In `parseFiles`, alongside `symbols`, add `var calls: [ScanResult.CallRef] = []`, `var seenCalls = Set<String>()`, `var currentCallable: String? = nil`. After the symbol block for a line, add:

```swift
                    if let last = symbols.last, last.line == idx + 1 {
                        // A declaration line opens a new callable (or a type, which closes the current one).
                        if last.kind == "function" { currentCallable = last.name }
                        else if last.kind == "method", let p = last.parent { currentCallable = "\(p).\(last.name)" }
                        else { currentCallable = nil }
                    } else if let caller = currentCallable, calls.count < Self.maxCallsPerFile {
                        // Strip a trailing line comment; strings are not stripped (cheap heuristic,
                        // unresolvable names are dropped by the builder anyway).
                        let code = line.components(separatedBy: "//").first ?? line
                        let ns = code as NSString
                        for m in Self.callRegex.matches(in: code, range: NSRange(location: 0, length: ns.length)) {
                            let name = ns.substring(with: m.range(at: 1))
                            guard !Self.nonCallKeywords.contains(name) else { continue }
                            let calleeLast = caller.split(separator: ".").last.map(String.init) ?? caller
                            guard name != calleeLast else { continue }        // no self-recursion edges
                            if seenCalls.insert("\(caller)>\(name)").inserted {
                                calls.append(ScanResult.CallRef(caller: caller, callee: name, line: idx + 1))
                            }
                        }
                    }
```

and pass `calls: calls` in the `RawFileStructure(...)` return.

In `StructureGraphBuilder.swift`, replace the whole `// ── Calls edges` section with:

```swift
        // ── Calls edges (symbol → symbol, INFERRED) ───────────────────────────
        // Resolution order: a symbol of that name in the SAME file, then in files
        // this file imports, then a name defined exactly once in the repo. A name
        // that is ambiguous at the stage that finds it is skipped — a wrong edge
        // is worse than a missing one.
        var idsByFileName: [String: [String: [String]]] = [:]
        var idsByName: [String: [String]] = [:]
        for n in nodes where n.kind == .function {
            guard let path = n.metadata["source_file"] else { continue }
            let key = n.id.split(separator: ":").dropFirst(2).joined(separator: ":")   // "name" or "Parent.name"
            let plain = String(key.split(separator: ".").last ?? Substring(key))
            for k in Set([key, plain]) { idsByFileName[path, default: [:]][k, default: []].append(n.id) }
            idsByName[plain, default: []].append(n.id)
        }
        var seenCallEdges = Set<String>()
        for (filePath, refs) in scan.calls {
            for ref in refs {
                guard let callerIds = idsByFileName[filePath]?[ref.caller], callerIds.count == 1 else { continue }
                let callerId = callerIds[0]
                var calleeId: String?
                if let same = idsByFileName[filePath]?[ref.callee] {
                    calleeId = same.count == 1 ? same[0] : nil
                    if same.count > 1 { continue }
                }
                if calleeId == nil {
                    let imported = (scan.imports[filePath] ?? []).flatMap { idsByFileName[$0]?[ref.callee] ?? [] }
                    if imported.count == 1 { calleeId = imported[0] } else if imported.count > 1 { continue }
                }
                if calleeId == nil, let global = idsByName[ref.callee], global.count == 1 { calleeId = global[0] }
                guard let callee = calleeId, callee != callerId else { continue }
                guard seenCallEdges.insert("\(callerId)>\(callee)").inserted else { continue }
                edges.append(CGEdge(fromId: callerId, toId: callee, kind: .calls, confidence: .inferred))
            }
        }
```

(If `CGNode.kind` for methods is also `.function` — it is, per `nodeKindAndPrefix` — both functions and methods are covered.)

- [ ] **Step 4: Run** — filtered suites, `swift test`, both labs. The engine lab may report more edges; if it asserts exact edge counts on a fixture, update the expected count and name it in the report with the before/after numbers.
- [ ] **Step 5: Commit**

```bash
git add Sources/GraphKit/Scan/FileStructureExtractor.swift Sources/GraphKit/Build/StructureGraphBuilder.swift Tests/GraphKitTests
git commit -m "feat: infer call edges from the regex extractor with conservative resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task D4: versioned scan cache and untracked files

**Files:** Modify `Sources/GraphKit/Cache/ScanCache.swift`, `Sources/GraphKit/Scan/StructureScanner.swift` (git file listing). Test: `Tests/GraphKitTests/ScanCacheVersionTests.swift` (create).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
import GraphCore
@testable import GraphKit

/// The cache version was a hard-coded "1", so an extractor upgrade kept serving
/// structures parsed by the old extractor for every unchanged file.
final class ScanCacheVersionTests: XCTestCase {
    func testACacheFromAnOlderExtractorIsDiscarded() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("gk-cache-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        var old = ScanCache(version: "1")
        old.entries["a.swift"] = .init(hash: "h", structure: RawFileStructure(path: "a.swift", language: "swift", loc: 1, rawImports: [], symbols: []))
        old.save(forRepo: root)
        XCTAssertTrue(ScanCache.load(forRepo: root).entries.isEmpty)
        XCTAssertEqual(ScanCache().version, ScanCache.currentVersion)
    }

    func testACurrentCacheRoundTrips() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("gk-cache-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        var cur = ScanCache()
        cur.entries["a.swift"] = .init(hash: "h", structure: RawFileStructure(path: "a.swift", language: "swift", loc: 1, rawImports: [], symbols: []))
        cur.save(forRepo: root)
        XCTAssertEqual(ScanCache.load(forRepo: root).entries.count, 1)
    }
}
```

- [ ] **Step 2: Run to verify failure** — `swift test --filter ScanCacheVersionTests` — Expected: compile FAIL (`currentVersion`).
- [ ] **Step 3: Implement** — in `ScanCache`:

```swift
    /// Bump whenever the extractor's OUTPUT changes (new fields, new kinds,
    /// new edges): a cache written by an older extractor is then discarded
    /// instead of serving stale structures for every unchanged file.
    /// "2": declarations kept, methods parent-qualified, call refs emitted.
    public static let currentVersion = "2"
```

change `public init(version: String = "1", …)` to `public init(version: String = ScanCache.currentVersion, …)` and the load guard `cache.version == "1"` to `cache.version == Self.currentVersion`.

In `StructureScanner.swift`'s git listing, after the tracked-files call succeeds, also list untracked-but-not-ignored files and union them (sorted, deduped):

```swift
                if exit == 0 {
                    var files = (String(data: out, encoding: .utf8) ?? "").split(separator: "\n").map(String.init)
                    // New files the user has not `git add`ed yet are part of the code
                    // they are working on; .gitignore still excludes build output.
                    if let (ex2, out2, _) = try? await launcher.run(
                        executable: git,
                        arguments: ["-C", repoRoot.path, "ls-files", "--others", "--exclude-standard"],
                        environment: nil), ex2 == 0 {
                        files += (String(data: out2, encoding: .utf8) ?? "").split(separator: "\n").map(String.init)
                    }
                    return Array(Set(files)).sorted()
                        .filter { exts.contains(($0 as NSString).pathExtension.lowercased()) }
                }
```

- [ ] **Step 4: Run** — `swift test --filter ScanCacheVersionTests`, `swift test`, both labs.
- [ ] **Step 5: Commit** (two commits: cache, then listing)

```bash
git add Sources/GraphKit/Cache/ScanCache.swift Tests/GraphKitTests/ScanCacheVersionTests.swift
git commit -m "fix: key the scan cache on the extractor version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add Sources/GraphKit/Scan/StructureScanner.swift
git commit -m "feat: include untracked, non-ignored files in the structure scan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task D5 (llm-ide): the server knows how fresh a graph is

**Files:**
- Create: `extension/kb/migrations/0036_code_graph_meta.sql`
- Modify: `extension/kb/code-graph.mjs` (`setCodeGraphMeta`, `getCodeGraphMeta`), `extension/kb/db.mjs` (re-export), `extension/connectors/structure-graph.mjs` (`ingestStructureGraph` opts), `extension/routes/router.mjs` (`/kb/ingest-code-graph` passes the fields), `extension/llm_agent/runtime/handlers/find-code.mjs` (`staleGraph`)
- Modify (Mac): `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/LlmIdeAPIClient+CodeGraph.swift` (`ingestCodeGraph(... commitSha:generatedAt:)`), `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/CodeGraphUploadService.swift` (first batch sends them)
- Docs: `CLAUDE.md` + the docs pages docs-check requires for the migration head (0036)
- Tests: `extension/tests/code-graph-freshness.test.mjs` (create); `mac/Tests/LlmIdeMacTests/CodeGraphUploadServiceTests.swift` (payload encodes commitSha)

**Interfaces:**
- `setCodeGraphMeta(userId, repoId, { commitSha, generatedAt })` (upsert); `getCodeGraphMeta(userId, repoIds: string[]) → Array<{ repo_id, commit_sha, generated_at }>`
- `ingestStructureGraph(userId, repoPath, graph, { replace, commitSha, generatedAt })` writes meta when `replace` is true
- find-code result gains optional `staleGraph: Array<{ repo: string, graphCommit: string, headCommit: string }>` (short SHAs) and a `hint` sentence, ONLY when a scoped repo's HEAD differs from its graph commit.

- [ ] **Step 1: Migration** — `0036_code_graph_meta.sql`:

```sql
-- Which commit a repo's code graph was generated from. Without it the server
-- could not tell the model that line numbers and symbols may be out of date.
CREATE TABLE IF NOT EXISTS code_graph_meta (
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT,
  generated_at TEXT,
  PRIMARY KEY (user_id, repo_id)
);
```

- [ ] **Step 2: Write the failing test** — `extension/tests/code-graph-freshness.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-graph-freshness-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { ingestStructureGraph } = await import('../connectors/structure-graph.mjs');
const { handleFindCode } = await import('../llm_agent/runtime/handlers/find-code.mjs');

const U = users.registerUser(db.getDb(), { email: `fr-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'f' }).id;
const REPO = fs.mkdtempSync(path.join(__dirname, '_fr-repo-'));
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(REPO, 'a.ts'), 'export function freshSym() {}\n');
git('add', '.'); git('commit', '-q', '-m', 'one');
const C1 = git('rev-parse', 'HEAD');
db.addUserRepo(U, REPO);
const graph = { nodes: [
  { id: 'file:a.ts', title: 'a.ts', kind: 'file', metadata: { source_file: 'a.ts', line: 'L0' } },
  { id: 'function:a.ts:freshSym', title: 'freshSym', kind: 'function', metadata: { source_file: 'a.ts', line: 'L1' } },
], edges: [] };

test.after(() => {
  db.closeDb();
  fs.rmSync(REPO, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('ingest stores the graph commit on the replacing batch', () => {
  ingestStructureGraph(U, REPO, graph, { replace: true, commitSha: C1, generatedAt: '2026-09-29T00:00:00Z' });
  assert.deepEqual(db.getCodeGraphMeta(U, [REPO]).map((m) => m.commit_sha), [C1]);
});

test('find-code is quiet while the graph matches HEAD', () => {
  const out = handleFindCode({ query: 'freshSym' }, { userId: U, roots: [REPO], workspaceRoot: REPO });
  assert.equal(out.staleGraph, undefined);
});

test('find-code reports staleGraph once HEAD moves', () => {
  fs.writeFileSync(path.join(REPO, 'b.ts'), 'export const x = 1;\n');
  git('add', '.'); git('commit', '-q', '-m', 'two');
  const out = handleFindCode({ query: 'freshSym' }, { userId: U, roots: [REPO], workspaceRoot: REPO, freshnessCacheMs: 0 });
  assert.ok(Array.isArray(out.staleGraph) && out.staleGraph.length === 1);
  assert.equal(out.staleGraph[0].graphCommit, C1.slice(0, 7));
  assert.match(out.hint || '', /graph|stale|line numbers/i);
});
```

- [ ] **Step 3: Run to verify failure** — `cd extension && node --test tests/code-graph-freshness.test.mjs` — Expected: FAIL.

- [ ] **Step 4: Implement**

`kb/code-graph.mjs` (append):

```js
/** Upsert which commit a repo's graph was generated from (migration 0036). */
export function setCodeGraphMeta(userId, repoId, { commitSha = null, generatedAt = null } = {}) {
  requireUser(userId);
  const sha = typeof commitSha === 'string' && /^[0-9a-f]{7,64}$/i.test(commitSha) ? commitSha : null;
  const at = typeof generatedAt === 'string' ? generatedAt.slice(0, 40) : null;
  getDb().prepare(
    `INSERT INTO code_graph_meta (user_id, repo_id, commit_sha, generated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, repo_id) DO UPDATE SET commit_sha=excluded.commit_sha, generated_at=excluded.generated_at`,
  ).run(userId, repoId, sha, at);
}

export function getCodeGraphMeta(userId, repoIds) {
  requireUser(userId);
  if (!Array.isArray(repoIds) || repoIds.length === 0) return [];
  return getDb().prepare(
    `SELECT repo_id, commit_sha, generated_at FROM code_graph_meta
     WHERE user_id=? AND repo_id IN (${repoIds.map(() => '?').join(',')})`,
  ).all(userId, ...repoIds);
}
```

Re-export both from `kb/db.mjs`. In `ingestStructureGraph`, inside the transaction after the write: `if (replace && (opts.commitSha || opts.generatedAt)) setCodeGraphMeta(userId, repoId, { commitSha: opts.commitSha, generatedAt: opts.generatedAt });` (import `setCodeGraphMeta` from `../kb/code-graph.mjs`). In `routes/router.mjs` `/kb/ingest-code-graph`, pass `{ replace: body.replace === true, commitSha: typeof body.commitSha === 'string' ? body.commitSha : null, generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : null }`.

`find-code.mjs`: add

```js
import { execFileSync } from 'node:child_process';
import { getCodeGraphMeta } from '../../../kb/db.mjs';

// HEAD per repo, cached briefly: find-code runs on the server's only thread
// and a git spawn per call would add up in a busy turn.
const headCache = new Map();
function headCommit(repo, maxAgeMs) {
  const hit = headCache.get(repo);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.sha;
  let sha = null;
  try {
    sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { sha = null; }
  headCache.set(repo, { sha, at: Date.now() });
  return sha;
}

/** Scoped repos whose graph commit differs from HEAD (short SHAs), or []. */
function staleGraphs(userId, repoIds, maxAgeMs) {
  if (!Array.isArray(repoIds) || repoIds.length === 0) return [];
  const out = [];
  for (const m of getCodeGraphMeta(userId, repoIds)) {
    if (!m.commit_sha) continue;
    const head = headCommit(m.repo_id, maxAgeMs);
    if (head && head !== m.commit_sha) {
      out.push({ repo: m.repo_id.split(/[/\\]/).pop(), graphCommit: m.commit_sha.slice(0, 7), headCommit: head.slice(0, 7) });
    }
  }
  return out;
}
```

and in `handleFindCode`, keep the computed `repoIds` in a variable visible after the search (declare `let repoIds = null;` before the `try`), then before building the return value:

```js
  const stale = (() => {
    try { return staleGraphs(ctx.userId, repoIds, Number.isFinite(ctx.freshnessCacheMs) ? ctx.freshnessCacheMs : 30_000); }
    catch { return []; }
  })();
```

and add to the returned object (only when non-empty) `staleGraph: stale` and a `hint` of `'The code graph was generated from an older commit than HEAD — line numbers and recently added symbols may be out of date; confirm with a narrow read before citing them.'` — if the result already has a `hint` field, append this sentence to it rather than replacing it.

Mac: in `LlmIdeAPIClient+CodeGraph.swift` add `commitSha: String? = nil, generatedAt: String? = nil` parameters to `ingestCodeGraph`, and `let commitSha: String?; let generatedAt: String?` to `Req` (nil fields are omitted by `JSONEncoder`). In `CodeGraphUploadService`, compute once per upload (before batching) the repo's HEAD with `/usr/bin/git -C <repoRoot> rev-parse HEAD` (use the existing process helper the file or its neighbours already use for git; if none, a `Process` with a 3 s timeout off the main actor) and an ISO-8601 `generatedAt`, and pass them on the batch that has `replace: true` only.

Test (Mac, append to `CodeGraphUploadServiceTests`): encode the `Req` for a first batch with `commitSha: "abc1234"` and assert the JSON contains `"commitSha":"abc1234"`; for a non-first batch assert the key is absent. (If `Req` is a local type inside the function, extract it to a `fileprivate`/`internal` struct `CodeGraphIngestRequest` so it can be tested, and say so.)

Docs: add migration 0036 to `CLAUDE.md` ("0001–0036") and every docs page docs-check flags.

- [ ] **Step 5: Run** — `cd extension && node --test tests/code-graph-freshness.test.mjs tests/find-code.test.mjs tests/code-graph-store.test.mjs`, full `npm test` (unsandboxed), `npm run lint`, `make docs-check` (unsandboxed); Mac: `LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter CodeGraphUploadServiceTests`, full Mac suite, `bash mac/Scripts/feature-boundaries.sh`.
- [ ] **Step 6: Commit** (three commits, llm-ide): server store + ingest + migration + docs; find-code staleGraph; Mac upload fields.

```bash
git commit -m "feat(server): record which commit a code graph was generated from" …
git commit -m "feat(server): find-code warns when the code graph is older than HEAD" …
git commit -m "feat(mac): upload the repo HEAD commit with the code graph" …
```
(each ending with the Co-Authored-By trailer; stage only the files of that commit)

---

### Task D6 (llm-ide): code notes list every type kind and methods

**Files:** Modify `mac/Sources/LlmIdeMac/Features/CodeGraph/Notes/CodeNoteGenerator.swift` (the `kind == "class"` / `kind == "function"` filters at ~L102, L115, L171, L184, L221, L223). Test: the existing CodeNoteGenerator tests file under `mac/Tests/LlmIdeMacTests/` (find it with `/usr/bin/grep -rl CodeNoteGenerator mac/Tests`), or create `CodeNoteGeneratorKindsTests.swift`.

- [ ] **Step 1: Write the failing test** — a scan whose file has symbols of kinds `struct`, `enum`, `protocol`, `extension`, `class`, `method` (parent set) and `function`; assert the generated per-file note (or index — use the same generator entry point the existing tests use) mentions every type name and both the method and the function name.
- [ ] **Step 2: Run to verify failure** (unsandboxed) — `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter CodeNoteGenerator` — Expected: FAIL (struct/enum/protocol/extension/method missing).
- [ ] **Step 3: Implement** — add in `CodeNoteGenerator`:

```swift
    /// Symbol kinds rendered as "types" / "functions" in notes. The regex
    /// extractor emits struct/enum/protocol/extension/interface and (since
    /// graph-kit's parent attribution) `method`; filtering on "class" and
    /// "function" alone dropped all of them from index.md and the file notes.
    static let typeKinds: Set<String> = ["class", "struct", "enum", "protocol", "extension", "interface"]
    static let functionKinds: Set<String> = ["function", "method"]
```

and replace each `$0.kind == "class"` with `Self.typeKinds.contains($0.kind)` and each `$0.kind == "function"` with `Self.functionKinds.contains($0.kind)`. Where a method is listed, render it as `Parent.name` when `parent` is set.
- [ ] **Step 4: Run** — the filtered test, full Mac suite, `bash mac/Scripts/feature-boundaries.sh`.
- [ ] **Step 5: Commit** — `fix(mac): code notes list every type kind and methods` (+ trailer).

---

## Final verification

- [ ] graph-kit: `swift build`, `swift test`, both labs `PASS`; `git log --oneline main..feat/phase-d-graph` shows D0–D4; nothing pushed.
- [ ] llm-ide: `npm test` green, lint 0, docs-check 0, Mac full suite 0 failures, boundaries 0.
- [ ] Integration against the local graph-kit (then undone): `cd mac && swift package edit graph-kit --path LocalPackages/graph-kit && swift build && LLMIDE_KEYCHAIN_BACKEND=memory swift test > "$TMPDIR/d-int.log" 2>&1; swift package unedit graph-kit` — the suite must pass; afterwards `git status` in llm-ide shows no change to `Package.resolved` (if it does, restore it with `git checkout -- mac/Package.resolved`).
