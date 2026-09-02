import Foundation
import GraphCore
import GraphKit

/// Engine-level gate: the invariants of graph *generation* — containment
/// direction, cross-link precedence, declared-module linking, fingerprint
/// stability — asserted by an executable because this toolchain has neither
/// XCTest nor swift-testing.
///
/// The layout gate (`graph-layout-lab`) covers how a graph is drawn; this one
/// covers what the engine produces. They are separate executables because they
/// depend on different products: the layout gate must build with the engine
/// unplugged, this one exists to test the engine.
///
/// Usage: swift run graph-engine-lab

var failures: [String] = []

func check(_ condition: Bool, _ name: String, _ detail: @autoclosure () -> String) {
    if condition {
        print("  ✔ \(name)")
    } else {
        print("  ✘ \(name): \(detail())")
        failures.append(name)
    }
}

// MARK: - Fixtures

/// A small code graph shaped like `StructureGraphBuilder` output.
func codeGraph() -> CGData {
    CGData(nodes: [
        CGNode(id: "file:kb/db.mjs", title: "db.mjs", kind: .file,
               metadata: ["source_file": "kb/db.mjs"]),
        CGNode(id: "file:kb/auth.mjs", title: "auth.mjs", kind: .file,
               metadata: ["source_file": "kb/auth.mjs"]),
        CGNode(id: "file:src/app.ts", title: "app.ts", kind: .file,
               metadata: ["source_file": "src/app.ts"]),
        CGNode(id: "function:kb/db.mjs:backupTo", title: "backupTo", kind: .function,
               metadata: ["source_file": "kb/db.mjs"]),
    ], edges: [
        CGEdge(fromId: "file:kb/db.mjs", toId: "function:kb/db.mjs:backupTo",
               kind: .contains, confidence: .extracted),
    ])
}

func chunk(id: String, title: String, body: String,
           wikiLinks: [String] = [], relatedModules: [String] = []) -> MemoryChunk {
    MemoryChunk(id: id, docURL: URL(fileURLWithPath: "/tmp/doc.md"),
                docTitle: "doc", headingPath: [title], body: body,
                kind: .memoryChunk, tags: [], wikiLinks: wikiLinks,
                graphOnly: false, relatedModules: relatedModules)
}

print("")
print("graph-engine-lab — generation invariants")
print(String(repeating: "═", count: 72))

// MARK: - MemoryGenerator: containment direction

print("")
print("▸ MemoryGenerator")
let workspace = FileManager.default.temporaryDirectory
    .appendingPathComponent("engine-lab-\(UUID().uuidString)", isDirectory: true)
try! FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
// NOT `defer` — `exit()` bypasses deferred blocks, which leaked one
// `engine-lab-*` directory into the temp dir per run (24 found).
func cleanupWorkspace() { try? FileManager.default.removeItem(at: workspace) }

try! """
# Alpha
body about alpha with [[Beta]]

## Beta
body about beta
""".write(to: workspace.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)

let memory = MemoryGenerator.generate(from: workspace)
check(memory.docCount == 1, "walks the doc", "docCount \(memory.docCount)")
check(memory.chunks.count == 2, "chunks by heading", "\(memory.chunks.count) chunks")

let docNode = memory.graph.nodes.first { $0.kind == .memoryDoc }
check(docNode != nil, "emits a doc node", "no memoryDoc node")
if let docNode {
    // Containment must be `doc contains chunk`, parent→child, EXTRACTED —
    // the corrected contract. `chunk → doc` as `relatedTo` made a document's
    // backbone indistinguishable from title-match noise, and a real 13-doc
    // folder shattered into 209 single-node components.
    let containment = memory.graph.edges.filter {
        $0.fromId == docNode.id && $0.kind == .contains && $0.confidence == .extracted
    }
    check(containment.count == 2, "doc contains its chunks (parent→child)",
          "\(containment.count) containment edges from the doc node")
    let inverted = memory.graph.edges.filter { $0.toId == docNode.id && $0.kind == .relatedTo }
    check(inverted.isEmpty, "containment is not emitted as relatedTo",
          "\(inverted.count) chunk→doc relatedTo edges")
}

// Multi-root union dedups nodes when the same root is passed twice.
let union = MemoryGenerator.generate(roots: [workspace, workspace])
check(union.graph.nodes.count == memory.graph.nodes.count,
      "generate(roots:) dedups repeated roots",
      "\(union.graph.nodes.count) vs \(memory.graph.nodes.count) nodes")

// MARK: - DocSetFingerprint

print("")
print("▸ DocSetFingerprint")
let first = DocSetFingerprint.compute(roots: [workspace])
let second = DocSetFingerprint.compute(roots: [workspace])
check(first == second, "stable when nothing changed", "two runs differ")

// An excluded directory's contents must not affect the fingerprint.
let vendor = workspace.appendingPathComponent("node_modules", isDirectory: true)
try! FileManager.default.createDirectory(at: vendor, withIntermediateDirectories: true)
try! "# vendored readme".write(to: vendor.appendingPathComponent("README.md"),
                               atomically: true, encoding: .utf8)
check(DocSetFingerprint.compute(roots: [workspace]) == first,
      "ignores ExcludedDirs contents", "a node_modules README changed the fingerprint")

try! "# Alpha\nedited body\n".write(to: workspace.appendingPathComponent("notes.md"),
                                    atomically: true, encoding: .utf8)
check(DocSetFingerprint.compute(roots: [workspace]) != first,
      "changes when a doc changes", "an edit left the fingerprint unchanged")

// MARK: - GraphMerger: cross-link mechanisms and precedence

print("")
print("▸ GraphMerger")
let code = codeGraph()

// 1. Wikilink → code symbol, EXTRACTED (author-asserted).
let wiki = chunk(id: "c-wiki", title: "Design", body: "text", wikiLinks: ["backupTo"])
var merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [wiki])
check(merged.edges.contains {
    $0.fromId == "c-wiki" && $0.toId == "function:kb/db.mjs:backupTo"
        && $0.kind == .references && $0.confidence == .extracted
}, "wikilink → references/EXTRACTED", "missing or wrong-typed wikilink edge")

// 2. Backtick mention → INFERRED (a heuristic over surface text).
let mention = chunk(id: "c-mention", title: "Ops", body: "Backups run through `backupTo`.")
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [mention])
check(merged.edges.contains {
    $0.fromId == "c-mention" && $0.toId == "function:kb/db.mjs:backupTo"
        && $0.kind == .references && $0.confidence == .inferred
}, "backtick mention → references/INFERRED", "missing or wrong-typed mention edge")

// 3. Unmarked prose must create NOTHING — generic words collide with symbols.
let prose = chunk(id: "c-prose", title: "Prose", body: "The backupTo routine runs nightly.")
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [prose])
check(!merged.edges.contains { $0.fromId == "c-prose" },
      "unmarked prose creates no edge", "prose manufactured a cross-link")

// 4. Declared module affinity → documents/EXTRACTED. This signal produced ZERO
//    edges before, while the noisy heuristic produced thousands — part of why a
//    real repo's 1589 doc chunks arrived fully disconnected from its code.
let declared = chunk(id: "c-mod", title: "KB guide", body: "how the kb works",
                     relatedModules: ["kb"])
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [declared])
let moduleLinks = merged.edges.filter {
    $0.fromId == "c-mod" && $0.kind == .documents && $0.confidence == .extracted
}
check(moduleLinks.count == 2, "related-modules → documents/EXTRACTED per file under the path",
      "\(moduleLinks.count) edges (expected kb/db.mjs and kb/auth.mjs)")
check(!moduleLinks.contains { $0.toId == "file:src/app.ts" },
      "related-modules respects the path prefix", "linked a file outside kb/")

// 5. Fan-out cap: a directory declaration cannot become an unbounded hub.
var wide = codeGraph()
var wideNodes = wide.nodes
for index in 0..<20 {
    wideNodes.append(CGNode(id: "file:kb/f\(index).mjs", title: "f\(index).mjs", kind: .file,
                            metadata: ["source_file": "kb/f\(index).mjs"]))
}
wide = CGData(nodes: wideNodes, edges: wide.edges)
merged = GraphMerger.merge(code: wide, doc: CGData(nodes: [], edges: []), chunks: [declared])
let capped = merged.edges.filter { $0.fromId == "c-mod" && $0.kind == .documents }
check(capped.count == 8, "related-modules fan-out capped at 8",
      "\(capped.count) edges for one declared module")

// 5b. Authoring forms: `./kb`, `kb/*`, `kb/**` must all resolve — before
//     normalisation they silently produced zero edges, the exact failure this
//     feature exists to close. Forms that cannot name a path stay nil.
for (form, expectation) in [("./kb", true), ("kb/*", true), ("kb/**", true),
                            ("kb/", true), ("Kb", true),
                            ("", false), (".", false), ("/", false),
                            ("src/../kb", false)] {
    let resolved = GraphMerger.normalizeModulePrefix(form)
    check((resolved == "kb") == expectation,
          "normalizeModulePrefix(\"\(form)\") \(expectation ? "resolves" : "is rejected")",
          "got \(resolved ?? "nil")")
}

// 5c. Fan-IN cap: when every chunk declares the same module, the files under
//     it must not absorb an edge from every chunk — that reintroduces the
//     hub-domination failure the layout work removed (measured: a 32×
//     repulsion-mass asymmetry at 1589 chunks).
let manyChunks = (0..<100).map {
    chunk(id: "c-many-\($0)", title: "s\($0)", body: "body", relatedModules: ["kb"])
}
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []),
                           chunks: manyChunks)
let fanIn = Dictionary(grouping: merged.edges.filter { $0.kind == .documents },
                       by: \.toId).mapValues(\.count)
check(fanIn.values.allSatisfy { $0 <= 32 }, "related-modules fan-in capped at 32",
      "max fan-in \(fanIn.values.max() ?? 0)")
check(!fanIn.isEmpty, "fan-in cap still lets the signal through", "no edges at all")

// 6. Precedence: a target already linked by wikilink is not re-linked by a
//    mention of the same symbol.
let both = chunk(id: "c-both", title: "Both", body: "Call `backupTo` now.",
                 wikiLinks: ["backupTo"])
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []), chunks: [both])
let hits = merged.edges.filter {
    $0.fromId == "c-both" && $0.toId == "function:kb/db.mjs:backupTo"
}
check(hits.count == 1 && hits[0].confidence == .extracted,
      "wikilink wins over mention for the same target",
      "\(hits.count) edges, first confidence \(hits.first?.confidence.rawValue ?? "-")")

// 6b. Wikilink also wins over related-modules for the same pair.
let wikiAndModule = chunk(id: "c-wm", title: "Guide", body: "text",
                          wikiLinks: ["db.mjs"], relatedModules: ["kb"])
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []),
                           chunks: [wikiAndModule])
let pairEdges = merged.edges.filter { $0.fromId == "c-wm" && $0.toId == "file:kb/db.mjs" }
check(pairEdges.count == 1 && pairEdges[0].kind == .references,
      "wikilink wins over related-modules for the same target",
      "\(pairEdges.count) edges, first kind \(pairEdges.first?.kind.rawValue ?? "-")")

// 7. A realistic doc side: chunk NODES and the containment backbone. Earlier
//    fixtures passed `doc: CGData(nodes: [], edges: [])`, which mutation
//    testing proved left three regressions green — dropping doc.edges entirely
//    passed, because no fixture ever gave the merge a doc edge to lose.
let realChunk = chunk(id: "chunk:real:0", title: "Section", body: "text")
let docSide = CGData(
    nodes: [CGNode(id: "doc:one", title: "One", kind: .memoryDoc),
            CGNode(id: "chunk:real:0", title: "Section", kind: .memoryChunk),
            // Deliberate id collision with the code side, so the dedup check
            // has something real to dedup — with disjoint fixtures it was
            // vacuously true even with the dedup deleted.
            CGNode(id: "file:kb/db.mjs", title: "db.mjs (dup)", kind: .file)],
    edges: [CGEdge(fromId: "doc:one", toId: "chunk:real:0",
                   kind: .contains, confidence: .extracted)],
    layers: [UALayer(id: "L1", name: "docs", nodeIds: ["doc:one"])],
    tour: [UATourStep(nodeId: "doc:one", title: "t", body: "b")])
merged = GraphMerger.merge(code: code, doc: docSide, chunks: [realChunk])
check(Set(merged.nodes.map(\.id)).count == merged.nodes.count, "union dedups node ids",
      "duplicate ids in the merged graph")
check(merged.nodes.count == code.nodes.count + 2, "colliding id keeps the code node",
      "\(merged.nodes.count) nodes")
check(merged.edges.contains {
    $0.fromId == "doc:one" && $0.toId == "chunk:real:0" && $0.kind == .contains
}, "doc-side edges survive the merge",
      "the containment backbone was dropped by the union")
check(!merged.layers.isEmpty && !merged.tour.isEmpty, "layers and tour survive the merge",
      "layers \(merged.layers.count), tour \(merged.tour.count)")
// Referential integrity on a realistic merge: every edge endpoint resolves.
let mergedIds = Set(merged.nodes.map(\.id))
check(merged.edges.allSatisfy { mergedIds.contains($0.fromId) && mergedIds.contains($0.toId) },
      "no dangling edge endpoints", "an edge points at a node not in the graph")

// 8. A chunk whose TITLE equals a code node's title must not link — titles are
//    generic ("Config", "Setup") and matching them manufactures false edges.
//    GraphMerger's own docstring names this invariant; mutation testing showed
//    it was previously unasserted (re-adding title matching stayed green).
let titleCollision = chunk(id: "c-title", title: "db.mjs", body: "no markers here")
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []),
                           chunks: [titleCollision])
check(!merged.edges.contains { $0.fromId == "c-title" },
      "a chunk title colliding with a code title creates no edge",
      "title matching manufactured a cross-link")

// 9. A path-shaped backtick mention resolves through the source_file inventory
//    (DocCodeLinker's 0.9 tier) — previously dead from the gate's view.
let pathMention = chunk(id: "c-path", title: "Ops", body: "See `kb/db.mjs` for details.")
merged = GraphMerger.merge(code: code, doc: CGData(nodes: [], edges: []),
                           chunks: [pathMention])
check(merged.edges.contains {
    $0.fromId == "c-path" && $0.toId == "file:kb/db.mjs" && $0.kind == .references
}, "path-shaped mention resolves via source_file inventory", "no edge for `kb/db.mjs`")

// 10. EdgeWeight tiers: the mechanism that replaced capDegree(6). If someone
//     re-tiers `documents` below the threshold, every related-modules edge the
//     checks above assert exists is silently deleted from the layout — with
//     this, the gate says so.
check(EdgeWeight.weight(of: CGEdge(fromId: "a", toId: "b", kind: .documents,
                                   confidence: .extracted))
        > EdgeWeight.defaultMinWeight,
      "documents/EXTRACTED clears the layout threshold", "related-modules edges would vanish")
check(EdgeWeight.weight(of: CGEdge(fromId: "a", toId: "b", kind: .references,
                                   confidence: .inferred))
        > EdgeWeight.defaultMinWeight,
      "references/INFERRED clears the layout threshold", "mention edges would vanish")
check(EdgeWeight.weight(of: CGEdge(fromId: "a", toId: "b", kind: .relatedTo,
                                   confidence: .extracted))
        < EdgeWeight.defaultMinWeight,
      "relatedTo stays below the threshold at any confidence", "noise would be laid out")
check(EdgeWeight.weight(of: CGEdge(fromId: "a", toId: "b", kind: .relatedTo,
                                   confidence: .ambiguous)) < 0.11 + 1e-9,
      "title-match noise weighs ~0.108 as documented",
      "the docstring's stated weight is wrong again")

// MARK: - Verdict

print("")
print(String(repeating: "═", count: 72))
cleanupWorkspace()
if failures.isEmpty {
    print("PASS — all generation invariants hold")
    print("")
    exit(0)
}
print("FAIL — \(failures.count) check(s) failed")
print("")
exit(1)
