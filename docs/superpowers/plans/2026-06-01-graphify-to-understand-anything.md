# Graphify → Understand-Anything Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the graphify CLI integration with Understand-Anything (UA) across the entire meet-notes system — Mac app, Claude Code skill, and gitignore — using an adapter-layer strategy that keeps CGData as the common interface.

**Architecture:** Producer layer (runner, parser, store, installer) is rewritten to target UA's JSON schema and npx-based invocation. The CGNodeKind and CGEdgeKind enums are expanded to cover UA's 21 node types and 35 edge types. All 20+ consumer files (views, services, view models) see the same CGData types with cosmetic renames.

**Tech Stack:** Swift 5.9+, SwiftUI, Swift Testing, Node.js >= 22, npx, Understand-Anything npm package

**Spec:** `docs/superpowers/specs/2026-06-01-graphify-to-understand-anything-design.md`

---

## File Structure

### CodeGraph/ (producer layer — rewrites)

| File | Responsibility |
|------|---------------|
| `UARunner.swift` | Locate npx/node, check Node.js version, shell out to `npx understand-anything analyze <folder>`, return path to knowledge-graph.json |
| `UAParser.swift` | Decode UA's versioned JSON into CGData. Map 21 node types and 35 edge types. Resolve file paths. Extract layers/tours. |
| `UAStore.swift` | Disk-cache for knowledge-graph.json per target folder (SHA256-keyed). Save/load/invalidate. |
| `UAError.swift` | Error enum: binaryMissing, nodeVersionTooOld, folderNotWritable, runFailed, noOutput, parseFailed, cancelled |
| `UAInstaller.swift` | Shell `npm install -g understand-anything` or platform-specific skill install |
| `CodeGraphModels.swift` | Expanded CGNodeKind (21+10 memory types), CGEdgeKind (35 types), UALayer, UATourStep structs, CGPalette update |

### CodeGraph/ (kept — minor edits)

| File | Change |
|------|--------|
| `MemoryStore.swift` | Path `graphify-out/memory` → `.understand-anything/memory` |
| `MemoryNotesWriter.swift` | Output dir `graphify-out/memory` → `.understand-anything/memory`, header text update |
| `BugReport.swift` | Comment update only (path in docstring) |
| `QAEntry.swift` | Comment update only |
| `ProcessLauncher.swift` | No change |
| `CodeGraphLayout.swift` | No change |
| `MemoryGenerator.swift` | No change |

### Views/CodeGraph/ (renames + UI string updates)

| Old file | New file |
|----------|----------|
| `GraphifyView.swift` | `UAGraphView.swift` |
| `GraphifyHelpers.swift` | `UAHelpers.swift` |

### Tests/ (rewrites matching new source)

| Old file | New file |
|----------|----------|
| `GraphifyParserTests.swift` | `UAParserTests.swift` |
| `GraphifyParserPathTests.swift` | `UAParserPathTests.swift` |
| `GraphifyInstallerTests.swift` | `UAInstallerTests.swift` |
| `MemoryStoreTests.swift` | Updated in-place (path assertions) |
| `MemoryStoreWritesTests.swift` | Updated in-place (path assertions) |
| `MemoryNotesWriterTests.swift` | Updated in-place (header text assertions) |

### Downstream renames (~20 files — string replacements only)

`Config.swift`, `Project.swift`, `ProjectStore.swift`, `PathValidator.swift`, `ShellState.swift`, `SidebarView.swift`, `MeetNotesMacApp.swift`, `AppShell.swift`, `LibraryItemStore.swift`, `AutoCodeUpdateService.swift`, `RegressionRunner.swift`, `PathsSettingsSection.swift`, `GitHubSettingsSection.swift`, `GitLabSettingsSection.swift`, `MemoryTabView.swift`, `AutoCodeView.swift`, `ReportBugSheet.swift`, `HelpGuideView.swift`, `RegressionView.swift`, `CodeGraphCanvas.swift`

---

## Task 1: Expand CGNodeKind and CGEdgeKind enums

**Files:**
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/CodeGraphModels.swift`

- [ ] **Step 1: Add new CGNodeKind cases**

In `CodeGraphModels.swift`, replace the `CGNodeKind` enum with the expanded version. Keep all existing cases (including memory note kinds). Add new cases for UA's node types:

```swift
public enum CGNodeKind: String, Sendable, Hashable {
    // --- Code (from UA) ---
    case file
    case function
    case classType
    case module
    case config
    case service
    case table
    case endpoint
    case pipeline
    case schemaNode
    case resource

    // --- Document ---
    case docPage

    // --- Domain (from UA) ---
    case domain
    case flow
    case step

    // --- Knowledge (from UA) ---
    case article
    case entity
    case topic
    case claim

    // --- Legacy graphify fallback ---
    case symbol

    // --- MemoryGenerator output (InfiniteBrain-style) ---
    case memoryDoc
    case memoryChunk
    case noteDecision
    case noteTask
    case noteQuestion
    case noteFact
    case noteConcept
    case notePlaybook
    case noteHypothesis
    case noteEvent
    case noteSource

    case other
}
```

- [ ] **Step 2: Update displayName for all new cases**

In the `public extension CGNodeKind` block, update the `displayName` computed property. Add entries for every new case:

```swift
public var displayName: String {
    switch self {
    case .file:           return "File"
    case .function:       return "Function"
    case .classType:      return "Class"
    case .module:         return "Module"
    case .config:         return "Config"
    case .service:        return "Service"
    case .table:          return "Table"
    case .endpoint:       return "Endpoint"
    case .pipeline:       return "Pipeline"
    case .schemaNode:     return "Schema"
    case .resource:       return "Resource"
    case .docPage:        return "Doc"
    case .domain:         return "Domain"
    case .flow:           return "Flow"
    case .step:           return "Step"
    case .article:        return "Article"
    case .entity:         return "Entity"
    case .topic:          return "Topic"
    case .claim:          return "Claim"
    case .symbol:         return "Symbol"
    case .memoryDoc:      return "Document"
    case .memoryChunk:    return "Note"
    case .noteDecision:   return "Decision"
    case .noteTask:       return "Task"
    case .noteQuestion:   return "Question"
    case .noteFact:       return "Fact"
    case .noteConcept:    return "Concept"
    case .notePlaybook:   return "Playbook"
    case .noteHypothesis: return "Hypothesis"
    case .noteEvent:      return "Event"
    case .noteSource:     return "Source"
    case .other:          return "Other"
    }
}
```

- [ ] **Step 3: Replace CGEdgeKind with expanded version**

Replace the entire `CGEdgeKind` enum:

```swift
public enum CGEdgeKind: String, Sendable, Hashable {
    // Structural
    case imports
    case exports
    case contains
    case inherits
    case implements

    // Behavioral
    case calls
    case subscribes
    case publishes
    case middleware

    // Data flow
    case readsFrom
    case writesTo
    case transforms
    case validates

    // Dependencies
    case dependsOn
    case testedBy
    case configures

    // Semantic
    case relatedTo
    case similarTo

    // Infrastructure
    case deploys
    case serves
    case provisions
    case triggers

    // Schema
    case migrates
    case documents
    case routes
    case definesSchema

    // Domain
    case containsFlow
    case flowStep
    case crossDomain

    // Knowledge
    case cites
    case contradicts
    case buildsOn
    case exemplifies
    case categorizedUnder
    case authoredBy

    // Legacy fallbacks
    case defines
    case references
}
```

- [ ] **Step 4: Update CGPalette for new node kinds**

Replace the `CGPalette` enum:

```swift
public enum CGPalette {
    public static func color(for kind: CGNodeKind) -> Color {
        switch kind {
        // Code
        case .file:           return .blue
        case .function:       return .purple
        case .classType:      return .indigo
        case .module:         return .orange
        case .config:         return .brown
        case .service:        return .teal
        case .table:          return .green
        case .endpoint:       return .red
        case .pipeline:       return .orange
        case .schemaNode:     return .green
        case .resource:       return .teal
        // Document
        case .docPage:        return .green
        // Domain
        case .domain:         return .red
        case .flow:           return Color(red: 1.0, green: 0.4, blue: 0.4)
        case .step:           return Color(red: 1.0, green: 0.6, blue: 0.5)
        // Knowledge
        case .article:        return .blue
        case .entity:         return .cyan
        case .topic:          return .cyan
        case .claim:          return .yellow
        // Legacy
        case .symbol:         return .purple
        // Memory
        case .memoryDoc:      return .indigo
        case .memoryChunk:    return .mint
        case .noteDecision:   return .red
        case .noteTask:       return .orange
        case .noteQuestion:   return .yellow
        case .noteFact:       return .green
        case .noteConcept:    return .cyan
        case .notePlaybook:   return .blue
        case .noteHypothesis: return .purple
        case .noteEvent:      return .pink
        case .noteSource:     return .brown
        case .other:          return .gray
        }
    }
}
```

- [ ] **Step 5: Add UALayer and UATourStep structs**

Append to the bottom of `CodeGraphModels.swift`:

```swift
public struct UALayer: Equatable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let nodeIds: [String]
}

public struct UATourStep: Equatable, Sendable {
    public let order: Int
    public let title: String
    public let description: String
    public let nodeIds: [String]
    public let languageLesson: String?
}
```

- [ ] **Step 6: Add layers and tour to CGData**

Update CGData to include the new optional arrays:

```swift
public struct CGData: Equatable, Sendable {
    public let nodes: [CGNode]
    public let edges: [CGEdge]
    public let layers: [UALayer]
    public let tour: [UATourStep]
    public init(nodes: [CGNode], edges: [CGEdge],
                layers: [UALayer] = [], tour: [UATourStep] = []) {
        self.nodes = nodes
        self.edges = edges
        self.layers = layers
        self.tour = tour
    }
    public static let empty = CGData(nodes: [], edges: [])
}
```

- [ ] **Step 7: Build to verify no compile errors**

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build 2>&1 | tail -5`

Expected: Build succeeds (possibly with existing warnings). The old `CGData(nodes:edges:)` call sites still work because `layers` and `tour` have default values.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeGraph/CodeGraphModels.swift
git commit -m "feat(models): expand CGNodeKind to 21 types and CGEdgeKind to 35 types for UA

Add UALayer and UATourStep structs. CGData gains optional layers/tour
arrays with backward-compatible defaults."
```

---

## Task 2: Create UAError

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeGraph/UAError.swift`
- Delete: `mac/Sources/MeetNotesMac/CodeGraph/GraphifyError.swift`

- [ ] **Step 1: Create UAError.swift**

```swift
import Foundation

public enum UAError: Error, Equatable {
    case binaryMissing
    case nodeVersionTooOld(found: String)
    case folderNotWritable(path: String)
    case runFailed(exitCode: Int32, stderrTail: String)
    case noOutput
    case parseFailed(message: String)
    case unsupportedSchema(version: String)
    case cancelled
}
```

- [ ] **Step 2: Delete GraphifyError.swift**

```bash
git rm mac/Sources/MeetNotesMac/CodeGraph/GraphifyError.swift
```

- [ ] **Step 3: Fix all references from GraphifyError to UAError**

Search the codebase for `GraphifyError` and replace with `UAError`:

Files that reference `GraphifyError`:
- `GraphifyRunner.swift` (will be replaced in Task 3)
- `GraphifyInstaller.swift` (will be replaced in Task 5)
- `GraphifyView.swift` (will be renamed in Task 8)

For now the build will have errors — they'll be resolved in subsequent tasks. This is fine since we're doing a coordinated rename.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeGraph/UAError.swift
git add mac/Sources/MeetNotesMac/CodeGraph/GraphifyError.swift
git commit -m "feat(codegraph): add UAError, remove GraphifyError

Adds nodeVersionTooOld case for Node.js version checking."
```

---

## Task 3: Create UARunner (replaces GraphifyRunner)

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeGraph/UARunner.swift`
- Delete: `mac/Sources/MeetNotesMac/CodeGraph/GraphifyRunner.swift`

- [ ] **Step 1: Create UARunner.swift**

```swift
// Wraps the external Understand-Anything CLI. Locates npx or a direct
// binary, checks Node.js version, and shells out to
// `npx understand-anything analyze <folder>`.

import Foundation

public final class UARunner {
    public static let installHint = "npm install -g understand-anything"
    public static let minimumNodeMajor = 22

    private static let fallbackBinaryPaths = [
        "/usr/local/lib/node_modules/understand-anything/bin/understand-anything",
        NSString(string: "~/.local/share/understand-anything/node_modules/.bin/understand-anything").expandingTildeInPath
    ]

    private let launcher: ProcessLauncher
    private let binaryURL: URL?    // direct binary, or nil → use npx
    private let npxURL: URL?

    public init(launcher: ProcessLauncher = SystemProcessLauncher(),
                binaryURL: URL? = UARunner.resolveDirectBinary(),
                npxURL: URL? = UARunner.resolveNpx()) {
        self.launcher = launcher
        self.binaryURL = binaryURL
        self.npxURL = npxURL
    }

    // MARK: - Binary resolution

    /// Locate the `understand-anything` binary directly (no npx).
    /// Honours an explicit override from Settings before falling
    /// back to common install locations.
    public static func resolveDirectBinary(override: String = "") -> URL? {
        let trimmed = override.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty {
            let expanded = (trimmed as NSString).expandingTildeInPath
            if FileManager.default.isExecutableFile(atPath: expanded) {
                return URL(fileURLWithPath: expanded)
            }
        }
        for p in fallbackBinaryPaths {
            if FileManager.default.isExecutableFile(atPath: p) {
                return URL(fileURLWithPath: p)
            }
        }
        return nil
    }

    /// Locate `npx` on PATH.
    public static func resolveNpx() -> URL? {
        guard let path = ProcessInfo.processInfo.environment["PATH"] else { return nil }
        for dir in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent("npx")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    /// Locate `node` on PATH for version checking.
    static func resolveNode() -> URL? {
        guard let path = ProcessInfo.processInfo.environment["PATH"] else { return nil }
        for dir in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent("node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    // MARK: - Node version check

    /// Parse major version from `node --version` output like "v22.5.1".
    static func parseNodeMajor(from versionString: String) -> Int? {
        let trimmed = versionString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("v") else { return nil }
        let afterV = trimmed.dropFirst()
        guard let dotIndex = afterV.firstIndex(of: ".") else {
            return Int(afterV)
        }
        return Int(afterV[afterV.startIndex..<dotIndex])
    }

    /// Check that Node.js >= 22 is available. Returns nil on success,
    /// or a UAError if the version is too old or node is missing.
    func checkNodeVersion() async -> UAError? {
        guard let node = Self.resolveNode() else {
            return .binaryMissing
        }
        do {
            let (exit, stdout, _) = try await launcher.run(executable: node, arguments: ["--version"], environment: nil)
            guard exit == 0 else { return .binaryMissing }
            let version = String(data: stdout, encoding: .utf8) ?? ""
            guard let major = Self.parseNodeMajor(from: version),
                  major >= Self.minimumNodeMajor else {
                return .nodeVersionTooOld(found: version.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            return nil
        } catch {
            return .binaryMissing
        }
    }

    // MARK: - Run

    /// Runs `understand-anything analyze <folder>` and returns the URL
    /// to the resulting `knowledge-graph.json`.
    public func run(targetFolder: URL) async -> Result<URL, UAError> {
        // Pre-check: folder writable
        if !FileManager.default.isWritableFile(atPath: targetFolder.path) {
            return .failure(.folderNotWritable(path: targetFolder.path))
        }

        // Pre-check: Node.js version
        if let versionError = await checkNodeVersion() {
            return .failure(versionError)
        }

        let outJSON = targetFolder
            .appendingPathComponent(".understand-anything", isDirectory: true)
            .appendingPathComponent("knowledge-graph.json")

        // Prefer direct binary, fall back to npx
        let (executable, args): (URL, [String])
        if let bin = binaryURL {
            executable = bin
            args = ["analyze", targetFolder.path]
        } else if let npx = npxURL {
            executable = npx
            args = ["understand-anything", "analyze", targetFolder.path]
        } else {
            return .failure(.binaryMissing)
        }

        do {
            let (exit, _, stderr) = try await launcher.run(executable: executable, arguments: args, environment: nil)
            if exit != 0 {
                return .failure(.runFailed(exitCode: exit, stderrTail: Self.safeTail(stderr, maxBytes: 800)))
            }
            guard FileManager.default.fileExists(atPath: outJSON.path) else {
                return .failure(.noOutput)
            }
            let stable = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("ua-\(UUID().uuidString).json")
            do {
                try FileManager.default.copyItem(at: outJSON, to: stable)
                return .success(stable)
            } catch {
                return .failure(.parseFailed(message: "failed to stage output: \(error.localizedDescription)"))
            }
        } catch is CancellationError {
            return .failure(.cancelled)
        } catch {
            return .failure(.runFailed(exitCode: -1, stderrTail: error.localizedDescription))
        }
    }

    /// Take the last `maxBytes` of `data` and decode as UTF-8.
    static func safeTail(_ data: Data, maxBytes: Int) -> String {
        guard data.count > maxBytes else {
            return String(data: data, encoding: .utf8) ?? ""
        }
        var start = data.count - maxBytes
        let limit = min(start + 4, data.count)
        while start < limit, (data[start] & 0xC0) == 0x80 { start += 1 }
        return String(data: data.subdata(in: start..<data.count), encoding: .utf8) ?? ""
    }
}
```

- [ ] **Step 2: Delete GraphifyRunner.swift**

```bash
git rm mac/Sources/MeetNotesMac/CodeGraph/GraphifyRunner.swift
```

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeGraph/UARunner.swift
git add mac/Sources/MeetNotesMac/CodeGraph/GraphifyRunner.swift
git commit -m "feat(codegraph): add UARunner, remove GraphifyRunner

Invokes understand-anything via npx or direct binary. Checks
Node.js >= 22 before running. Same ProcessLauncher seam for testing."
```

---

## Task 4: Create UAParser (replaces GraphifyParser)

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeGraph/UAParser.swift`
- Delete: `mac/Sources/MeetNotesMac/CodeGraph/GraphifyParser.swift`

- [ ] **Step 1: Create UAParser.swift**

```swift
// Parses Understand-Anything's `knowledge-graph.json` into the local CGData type.
//
// UA schema (v1.0.0):
//
//   {
//     "version": "1.0.0",
//     "kind": "codebase" | "knowledge",
//     "project": { "name", "languages", "frameworks", "description", "analyzedAt", "gitCommitHash" },
//     "nodes": [{ "id", "type", "name", "filePath", "lineRange", "summary", "tags", "complexity" }],
//     "edges": [{ "source", "target", "type", "direction", "description", "weight" }],
//     "layers": [{ "id", "name", "description", "nodeIds" }],
//     "tour": [{ "order", "title", "description", "nodeIds" }]
//   }

import Foundation
import CoreGraphics

public enum UAParser {

    // MARK: - Raw Decodable types

    private struct RawGraph: Decodable {
        let version: String?
        let nodes: [RawNode]?
        let edges: [RawEdge]?
        let layers: [RawLayer]?
        let tour: [RawTourStep]?
    }

    private struct RawNode: Decodable {
        let id: String
        let type: String?
        let name: String
        let filePath: String?
        let lineRange: [Int]?
        let summary: String?
        let tags: [String]?
        let complexity: String?
    }

    private struct RawEdge: Decodable {
        let source: String
        let target: String
        let type: String
        let direction: String?
        let description: String?
        let weight: Double?
    }

    private struct RawLayer: Decodable {
        let id: String
        let name: String
        let description: String
        let nodeIds: [String]?
    }

    private struct RawTourStep: Decodable {
        let order: Int
        let title: String
        let description: String
        let nodeIds: [String]?
        let languageLesson: String?
    }

    // MARK: - Public API

    /// Decode UA's `knowledge-graph.json`. `repoRoot` converts
    /// relative `filePath` values into absolute file URLs.
    public static func parse(data: Data, repoRoot: URL) throws -> CGData {
        let raw: RawGraph
        do {
            raw = try AppJSON.decoder.decode(RawGraph.self, from: data)
        } catch {
            throw UAError.parseFailed(message: error.localizedDescription)
        }

        guard let rawNodes = raw.nodes else {
            throw UAError.parseFailed(message: "knowledge-graph.json had no `nodes` field")
        }
        let rawEdges = raw.edges ?? []

        let nodes: [CGNode] = rawNodes.map { rn in
            let kind = mapNodeType(rn.type)
            var meta: [String: String] = [:]
            if let fp = rn.filePath, !fp.isEmpty {
                let abs = resolveFileURL(filePath: fp, repoRoot: repoRoot)
                meta["fileURL"] = abs.absoluteString
                let rootPath = repoRoot.standardizedFileURL.path
                let absPath = abs.standardizedFileURL.path
                if absPath.hasPrefix(rootPath + "/") {
                    meta["source_file"] = String(absPath.dropFirst(rootPath.count + 1))
                } else {
                    meta["source_file"] = fp
                }
            }
            if let lr = rn.lineRange, lr.count == 2 {
                meta["line"] = "L\(lr[0])-L\(lr[1])"
            }
            if let summary = rn.summary, !summary.isEmpty {
                meta["summary"] = summary
            }
            if let tags = rn.tags, !tags.isEmpty {
                meta["tags"] = tags.joined(separator: ", ")
            }
            if let complexity = rn.complexity, !complexity.isEmpty {
                meta["complexity"] = complexity
            }
            return CGNode(id: rn.id, title: rn.name, kind: kind, position: .zero, metadata: meta)
        }

        let edges: [CGEdge] = rawEdges.map { re in
            CGEdge(fromId: re.source, toId: re.target, kind: mapEdgeType(re.type))
        }

        let layers: [UALayer] = (raw.layers ?? []).map { rl in
            UALayer(id: rl.id, name: rl.name, description: rl.description, nodeIds: rl.nodeIds ?? [])
        }

        let tour: [UATourStep] = (raw.tour ?? []).map { rt in
            UATourStep(order: rt.order, title: rt.title, description: rt.description,
                       nodeIds: rt.nodeIds ?? [], languageLesson: rt.languageLesson)
        }

        return CGData(nodes: nodes, edges: edges, layers: layers, tour: tour)
    }

    // MARK: - File path resolution

    /// Resolve `filePath` (relative from UA) to an absolute file URL.
    /// Handles relative and stale absolute paths identically to the
    /// old GraphifyParser.resolveFileURL logic.
    static func resolveFileURL(filePath fp: String, repoRoot: URL) -> URL {
        if !fp.hasPrefix("/") {
            return repoRoot.appendingPathComponent(fp, isDirectory: false)
        }
        let rootPath = repoRoot.standardizedFileURL.path
        if fp.hasPrefix(rootPath + "/") || fp == rootPath {
            return URL(fileURLWithPath: fp)
        }
        let repoName = repoRoot.lastPathComponent
        let needle = "/\(repoName)/"
        if let range = fp.range(of: needle, options: .backwards) {
            let tail = String(fp[range.upperBound...])
            return repoRoot.appendingPathComponent(tail, isDirectory: false)
        }
        return URL(fileURLWithPath: fp)
    }

    // MARK: - Node type mapping

    /// UA node type aliases (applied before mapping).
    private static let nodeTypeAliases: [String: String] = [
        "func": "function", "method": "function",
        "struct": "class", "interface": "class", "enum": "class", "trait": "class",
        "mod": "module", "package": "module", "namespace": "module",
        "idea": "concept", "pattern": "concept",
        "doc": "document", "readme": "document",
        "configuration": "config", "settings": "config",
        "microservice": "service",
        "api": "endpoint", "route": "endpoint",
        "database": "table", "model": "table",
        "workflow": "pipeline", "ci_cd": "pipeline",
        "definition": "schema", "spec": "schema",
        "infra": "resource", "infrastructure": "resource",
        "business_domain": "domain", "bounded_context": "domain",
        "process": "flow", "use_case": "flow",
        "task": "step", "action": "step",
    ]

    static func mapNodeType(_ raw: String?) -> CGNodeKind {
        let normalized = (raw ?? "file").lowercased()
        let resolved = nodeTypeAliases[normalized] ?? normalized
        switch resolved {
        case "file":      return .file
        case "function":  return .function
        case "class":     return .classType
        case "module":    return .module
        case "concept":   return .noteConcept
        case "config":    return .config
        case "document":  return .docPage
        case "service":   return .service
        case "table":     return .table
        case "endpoint":  return .endpoint
        case "pipeline":  return .pipeline
        case "schema":    return .schemaNode
        case "resource":  return .resource
        case "domain":    return .domain
        case "flow":      return .flow
        case "step":      return .step
        case "article":   return .article
        case "entity":    return .entity
        case "topic":     return .topic
        case "claim":     return .claim
        case "source":    return .noteSource
        default:          return .other
        }
    }

    // MARK: - Edge type mapping

    private static let edgeTypeAliases: [String: String] = [
        "extends": "inherits", "invokes": "calls",
        "uses": "depends_on", "requires": "depends_on",
        "tests": "tested_by", "emits": "publishes",
        "listens": "subscribes", "reads": "reads_from",
        "writes": "writes_to", "references": "cites",
        "opposes": "contradicts", "extends_idea": "builds_on",
        "illustrates": "exemplifies", "tagged": "categorized_under",
        "written_by": "authored_by",
    ]

    static func mapEdgeType(_ raw: String) -> CGEdgeKind {
        let normalized = raw.lowercased()
        let resolved = edgeTypeAliases[normalized] ?? normalized
        switch resolved {
        case "imports":           return .imports
        case "exports":           return .exports
        case "contains":          return .contains
        case "inherits":          return .inherits
        case "implements":        return .implements
        case "calls":             return .calls
        case "subscribes":        return .subscribes
        case "publishes":         return .publishes
        case "middleware":        return .middleware
        case "reads_from":        return .readsFrom
        case "writes_to":        return .writesTo
        case "transforms":        return .transforms
        case "validates":         return .validates
        case "depends_on":        return .dependsOn
        case "tested_by":         return .testedBy
        case "configures":        return .configures
        case "related":           return .relatedTo
        case "similar_to":        return .similarTo
        case "deploys":           return .deploys
        case "serves":            return .serves
        case "provisions":        return .provisions
        case "triggers":          return .triggers
        case "migrates":          return .migrates
        case "documents":         return .documents
        case "routes":            return .routes
        case "defines_schema":    return .definesSchema
        case "contains_flow":     return .containsFlow
        case "flow_step":         return .flowStep
        case "cross_domain":      return .crossDomain
        case "cites":             return .cites
        case "contradicts":       return .contradicts
        case "builds_on":         return .buildsOn
        case "exemplifies":       return .exemplifies
        case "categorized_under": return .categorizedUnder
        case "authored_by":       return .authoredBy
        default:                  return .relatedTo
        }
    }
}
```

- [ ] **Step 2: Delete GraphifyParser.swift**

```bash
git rm mac/Sources/MeetNotesMac/CodeGraph/GraphifyParser.swift
```

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeGraph/UAParser.swift
git add mac/Sources/MeetNotesMac/CodeGraph/GraphifyParser.swift
git commit -m "feat(codegraph): add UAParser, remove GraphifyParser

Parses UA's versioned knowledge-graph.json with 21 node types, 35 edge
types, alias resolution, layers, and tours."
```

---

## Task 5: Create UAStore and UAInstaller

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeGraph/UAStore.swift`
- Create: `mac/Sources/MeetNotesMac/CodeGraph/UAInstaller.swift`
- Delete: `mac/Sources/MeetNotesMac/CodeGraph/GraphifyStore.swift`
- Delete: `mac/Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift`

- [ ] **Step 1: Create UAStore.swift**

Copy `GraphifyStore.swift` and rename:
- Class name: `GraphifyStore` → `UAStore`
- `RunMetadata.graphifyVersion` → `RunMetadata.toolVersion`
- `graph.json` → `knowledge-graph.json` in `save()` and `loadGraphJSON()`

```swift
import Foundation
import CryptoKit

public struct RunMetadata: Codable, Equatable, Sendable {
    public let timestamp: Date
    public let nodeCount: Int
    public let edgeCount: Int
    public let toolVersion: String
}

public final class UAStore {
    private let baseDirectory: URL
    private let fm = FileManager.default

    public init(baseDirectory: URL? = nil) {
        if let b = baseDirectory {
            self.baseDirectory = b
        } else {
            let appSupport = (try? FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true))
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.baseDirectory = appSupport
                .appendingPathComponent("MeetNotesMac", isDirectory: true)
                .appendingPathComponent("CodeGraph", isDirectory: true)
        }
    }

    public static func directoryName(for target: URL) -> String {
        let path = target.standardizedFileURL.path
        let digest = SHA256.hash(data: Data(path.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func dir(for target: URL) throws -> URL {
        let d = baseDirectory.appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
        try fm.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    public func save(graphJSON: Data, for target: URL, nodeCount: Int, edgeCount: Int, toolVersion: String) throws {
        let d = try dir(for: target)
        try graphJSON.write(to: d.appendingPathComponent("knowledge-graph.json"), options: .atomic)
        let meta = RunMetadata(timestamp: Date(), nodeCount: nodeCount, edgeCount: edgeCount, toolVersion: toolVersion)
        let metaData = try AppJSON.encoder.encode(meta)
        try metaData.write(to: d.appendingPathComponent("meta.json"), options: .atomic)
    }

    public func loadGraphJSON(for target: URL) -> Data? {
        let url = baseDirectory
            .appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
            .appendingPathComponent("knowledge-graph.json")
        return try? Data(contentsOf: url)
    }

    public func invalidate(for target: URL) {
        let cacheDir = baseDirectory
            .appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
        try? fm.removeItem(at: cacheDir)
    }

    public func lastRun(for target: URL) -> RunMetadata? {
        let url = baseDirectory
            .appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
            .appendingPathComponent("meta.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? AppJSON.decoder.decode(RunMetadata.self, from: data)
    }
}
```

- [ ] **Step 2: Create UAInstaller.swift**

```swift
import Foundation

final class UAInstaller {
    private let launcher: ProcessLauncher
    private let npxURL: URL?

    init(launcher: ProcessLauncher = SystemProcessLauncher(),
         npxURL: URL? = UARunner.resolveNpx()) {
        self.launcher = launcher
        self.npxURL = npxURL
    }

    /// Run `npx understand-anything install --platform <name>`.
    func install(cli: AICliTool) async -> Result<String, UAError> {
        guard let npx = npxURL else { return .failure(.binaryMissing) }
        let platform = Self.platformArgument(for: cli)
        let args = ["understand-anything", "install", "--platform", platform]
        do {
            let (exit, _, stderr) = try await launcher.run(executable: npx, arguments: args, environment: nil)
            if exit != 0 {
                return .failure(.runFailed(exitCode: exit, stderrTail: UARunner.safeTail(stderr, maxBytes: 800)))
            }
            return .success(platform)
        } catch is CancellationError {
            return .failure(.cancelled)
        } catch {
            return .failure(.runFailed(exitCode: -1, stderrTail: error.localizedDescription))
        }
    }

    static func platformArgument(for cli: AICliTool) -> String {
        switch cli {
        case .claudeCode: return "claude"
        case .cursor:     return "cursor"
        case .gemini:     return "gemini"
        case .copilot:    return "codex"
        }
    }
}
```

- [ ] **Step 3: Delete old files**

```bash
git rm mac/Sources/MeetNotesMac/CodeGraph/GraphifyStore.swift
git rm mac/Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift
```

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeGraph/UAStore.swift mac/Sources/MeetNotesMac/CodeGraph/UAInstaller.swift
git add mac/Sources/MeetNotesMac/CodeGraph/GraphifyStore.swift mac/Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift
git commit -m "feat(codegraph): add UAStore and UAInstaller, remove Graphify equivalents

UAStore caches knowledge-graph.json. UAInstaller invokes via npx."
```

---

## Task 6: Update MemoryStore and MemoryNotesWriter paths

**Files:**
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift`
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/MemoryNotesWriter.swift`
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/BugReport.swift`
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/QAEntry.swift`

- [ ] **Step 1: Update MemoryStore.swift**

Replace all occurrences of `graphify-out/memory` with `.understand-anything/memory`. Specifically:
- Line 1 comment: `graphify-out/memory/` → `.understand-anything/memory/`
- Line 24 default value: `"graphify-out/memory"` → `".understand-anything/memory"`
- Line 28 fallback: `"graphify-out/memory"` → `".understand-anything/memory"`
- Line 83 comment: `graphify-out/memory/bugs/` → `.understand-anything/memory/bugs/`
- Line 115 comment: `graphify-out/memory/q&a/` → `.understand-anything/memory/q&a/`
- Line 135: `Graphify skill` → `Understand-Anything skill`
- Line 138: `graphify-out/` → `.understand-anything/`

- [ ] **Step 2: Update MemoryNotesWriter.swift**

- Line 1 comment: `graphify-out/memory/graph-notes.md` → `.understand-anything/memory/graph-notes.md`
- Line 28-29: replace `"graphify-out"` with `".understand-anything"` in the path construction
- Line 44 header text: `"Auto-generated by Graphify"` → `"Auto-generated by Understand-Anything"`
- Line 45: `graphify update` → `understand-anything analyze`

- [ ] **Step 3: Update BugReport.swift comments**

- Line 2 comment: `<repo>/graphify-out/memory/bugs/<slug>.md` → `<repo>/.understand-anything/memory/bugs/<slug>.md`
- Line 6 comment: `Graphify's installed skill` → `the Understand-Anything skill`

- [ ] **Step 4: Update QAEntry.swift comments**

- Line 3 comment: `<repo>/graphify-out/memory/q&a/<slug>.md` → `<repo>/.understand-anything/memory/q&a/<slug>.md`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift mac/Sources/MeetNotesMac/CodeGraph/MemoryNotesWriter.swift mac/Sources/MeetNotesMac/CodeGraph/BugReport.swift mac/Sources/MeetNotesMac/CodeGraph/QAEntry.swift
git commit -m "chore(memory): update paths from graphify-out/ to .understand-anything/"
```

---

## Task 7: Update Config, Project, and AppConfig

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Models/Config.swift`
- Modify: `mac/Sources/MeetNotesMac/Models/Project.swift`
- Modify: `mac/Sources/MeetNotesMac/Models/PathValidator.swift`
- Modify: `mac/Sources/MeetNotesMac/Services/ProjectStore.swift`

- [ ] **Step 1: Update Config.swift**

Replace `graphifyBinaryOverride` with `uaBinaryOverride` throughout:
- Line 190-193: rename property and UserDefaults key
- Line 197: `defaultMemorySubdir` from `"graphify-out/memory"` to `".understand-anything/memory"`
- Line 307: defaults read key
- Line 463: property reference

Use find-and-replace: `graphifyBinaryOverride` → `uaBinaryOverride`, `"graphifyBinaryOverride"` → `"uaBinaryOverride"`

- [ ] **Step 2: Update Project.swift**

Line 66: `var graphifyBinaryOverride: String` → `var uaBinaryOverride: String`

- [ ] **Step 3: Update ProjectStore.swift**

Line 55: `graphifyBinaryOverride: ""` → `uaBinaryOverride: ""`

- [ ] **Step 4: Update PathValidator.swift**

- Line 59 comment: `Graphify's` → `Understand-Anything's`
- Line 64 message: `"the Graphify skill"` → `"the Understand-Anything skill"`
- Line 71 comment: `Graphify binary` → `UA binary`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/MeetNotesMac/Models/Config.swift mac/Sources/MeetNotesMac/Models/Project.swift mac/Sources/MeetNotesMac/Services/ProjectStore.swift mac/Sources/MeetNotesMac/Models/PathValidator.swift
git commit -m "chore(config): rename graphifyBinaryOverride to uaBinaryOverride

Update defaultMemorySubdir and PathValidator messages."
```

---

## Task 8: Rename views and update ShellState

**Files:**
- Rename: `mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift` → `UAGraphView.swift`
- Rename: `mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyHelpers.swift` → `UAHelpers.swift`
- Modify: `mac/Sources/MeetNotesMac/Services/ShellState.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/Shell/SidebarView.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/AppShell.swift` (if it references `GraphifyView`)
- Modify: `mac/Sources/MeetNotesMac/MeetNotesMacApp.swift`

- [ ] **Step 1: Rename and update GraphifyView.swift → UAGraphView.swift**

```bash
git mv mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift mac/Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift
```

Then in `UAGraphView.swift`, do these replacements throughout the 1383-line file:
- `struct GraphifyView` → `struct UAGraphView`
- `GraphifyRunner` → `UARunner`
- `GraphifyStore` → `UAStore`
- `GraphifyParser` → `UAParser`
- `GraphifyError` → `UAError`
- `GraphifyHelpers` → `UAHelpers`
- `graphifyBinaryOverride` → `uaBinaryOverride`
- UI string `"Graphify"` → `"Code Graph"` (for the tab/panel label)
- UI string `"Run Graphify"` → `"Analyze"`
- UI string `"Run Graphify on"` → `"Analyze"`
- UI string `"Running graphify…"` → `"Running analysis…"`
- UI string `"Graphify not installed."` → `"Understand-Anything not installed."`
- UI string `GraphifyRunner.installHint` → `UARunner.installHint`
- Comment strings: `graphify` → `understand-anything` where referring to the tool
- `"graphify-out/memory"` → `".understand-anything/memory"` in any path references

- [ ] **Step 2: Rename and update GraphifyHelpers.swift → UAHelpers.swift**

```bash
git mv mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyHelpers.swift mac/Sources/MeetNotesMac/Views/CodeGraph/UAHelpers.swift
```

In `UAHelpers.swift`:
- `enum GraphifyHelpers` → `enum UAHelpers`
- Update comments: `graphify` → `understand-anything` where referring to the tool

- [ ] **Step 3: Update ShellState.swift**

Replace the `.graphify` section case:
- Line 9: `case graphify` → `case codeGraph`
- Line 24: `case .graphify: return "Graphify"` → `case .codeGraph: return "Code Graph"`
- Line 41: `case .graphify:` → `case .codeGraph:` (icon stays the same)
- Line 53: `.graphify` → `.codeGraph`
- Line 112 comment: `Graphify` → `Code Graph`
- Line 128: `case .graphify:` → `case .codeGraph:`
- Line 145: `.graphify` → `.codeGraph`

- [ ] **Step 4: Update SidebarView.swift**

Line 47: `.graphify` → `.codeGraph`

- [ ] **Step 5: Update MeetNotesMacApp.swift**

Line 333: `ShellState.Section.graphify.rawValue` → `ShellState.Section.codeGraph.rawValue`

- [ ] **Step 6: Update AppShell.swift**

Replace any reference to `GraphifyView` with `UAGraphView`.

- [ ] **Step 7: Commit**

```bash
git add -A mac/Sources/MeetNotesMac/Views/CodeGraph/ mac/Sources/MeetNotesMac/Services/ShellState.swift mac/Sources/MeetNotesMac/Views/Shell/SidebarView.swift mac/Sources/MeetNotesMac/MeetNotesMacApp.swift mac/Sources/MeetNotesMac/Views/AppShell.swift
git commit -m "feat(ui): rename GraphifyView to UAGraphView, update all UI strings

Section.graphify → Section.codeGraph. User-facing labels now say
'Code Graph' and 'Analyze' instead of 'Graphify'."
```

---

## Task 9: Update remaining downstream files

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Services/LibraryItemStore.swift`
- Modify: `mac/Sources/MeetNotesMac/Services/AutoCodeUpdateService.swift`
- Modify: `mac/Sources/MeetNotesMac/Services/RegressionRunner.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/Settings/PathsSettingsSection.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/Settings/GitHubSettingsSection.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/Settings/GitLabSettingsSection.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/CodeGraphCanvas.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/AutoCode/AutoCodeView.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/CodeAssistant/ReportBugSheet.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/HelpGuideView.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/Regression/RegressionView.swift`
- Modify: `mac/Sources/MeetNotesMac/CodeGraph/ProcessLauncher.swift`

- [ ] **Step 1: Update LibraryItemStore.swift**

Line 40 comment: `graphify-out` → `.understand-anything`
Line 71: `"graphify-out"` → `".understand-anything"` in the skip list

- [ ] **Step 2: Update AutoCodeUpdateService.swift**

Line 324 comment: `graphify-out/memory/bugs/` → `.understand-anything/memory/bugs/`

- [ ] **Step 3: Update RegressionRunner.swift**

Line 2 comment: `graphify-out/memory/bugs/` → `.understand-anything/memory/bugs/`

- [ ] **Step 4: Update PathsSettingsSection.swift**

Replace all graphify references:
- Line 19 comment: `graphify-out/memory` → `.understand-anything/memory`
- Line 21 comment: `Graphify binary` → `UA binary`
- Line 22 comment: `graphify` → `understand-anything`
- Line 67: `graphifyBinaryRow` → `uaBinaryRow`
- Line 311: `"graphify-out/memory"` → `".understand-anything/memory"`, `"the Graphify skill"` → `"the Understand-Anything skill"`
- Lines 330-337: Rename the settings row:
  - `graphifyBinaryRow` → `uaBinaryRow`
  - label: `"Graphify binary"` → `"UA binary"`
  - help: update to mention `understand-anything` and `npx`
  - placeholder: `"/opt/homebrew/bin/graphify"` → `"npx understand-anything (leave empty to auto-discover)"`
  - `config.graphifyBinaryOverride` → `config.uaBinaryOverride`

- [ ] **Step 5: Update MemoryTabView.swift**

Line 37: `graphifyBinaryOverride` → `uaBinaryOverride`
Replace any `GraphifyRunner` references with `UARunner`.

- [ ] **Step 6: Update remaining view files**

For each of `GitHubSettingsSection.swift`, `GitLabSettingsSection.swift`, `AutoCodeView.swift`, `ReportBugSheet.swift`, `HelpGuideView.swift`, `RegressionView.swift`, `CodeGraphCanvas.swift`:
- Replace `Graphify`/`graphify` in comments and UI strings with `Understand-Anything`/`Code Graph` as appropriate
- Replace `GraphifyHelpers` with `UAHelpers` if referenced
- Replace `GraphifyRunner` with `UARunner` if referenced

- [ ] **Step 7: Update ProcessLauncher.swift comment**

Line 3: `GraphifyRunner` → `UARunner`

- [ ] **Step 8: Commit**

```bash
git add -A mac/Sources/
git commit -m "chore: rename all downstream graphify references to UA/understand-anything

Updates 13 files: services, settings, views, and comments."
```

---

## Task 10: Rewrite tests

**Files:**
- Create: `mac/Tests/MeetNotesMacTests/UAParserTests.swift`
- Create: `mac/Tests/MeetNotesMacTests/UAInstallerTests.swift`
- Delete: `mac/Tests/MeetNotesMacTests/GraphifyParserTests.swift`
- Delete: `mac/Tests/MeetNotesMacTests/GraphifyParserPathTests.swift`
- Delete: `mac/Tests/MeetNotesMacTests/GraphifyInstallerTests.swift`
- Modify: `mac/Tests/MeetNotesMacTests/MemoryStoreTests.swift`
- Modify: `mac/Tests/MeetNotesMacTests/MemoryStoreWritesTests.swift`
- Modify: `mac/Tests/MeetNotesMacTests/MemoryNotesWriterTests.swift`

- [ ] **Step 1: Create UAParserTests.swift**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct UAParserTests {
    private let repoRoot = URL(fileURLWithPath: "/repo")

    @Test func parsesMinimalValidGraph() throws {
        let json = """
        {
          "version": "1.0.0",
          "project": {
            "name": "test", "languages": ["swift"], "frameworks": [],
            "description": "Test", "analyzedAt": "2026-06-01T00:00:00Z",
            "gitCommitHash": "abc123"
          },
          "nodes": [
            {
              "id": "file:src/main.swift",
              "type": "file",
              "name": "main.swift",
              "filePath": "src/main.swift",
              "summary": "Entry point",
              "tags": ["entry"],
              "complexity": "simple"
            },
            {
              "id": "class:src/Foo.swift:Foo",
              "type": "class",
              "name": "Foo",
              "filePath": "src/Foo.swift",
              "lineRange": [10, 50],
              "summary": "Main class",
              "tags": ["core"],
              "complexity": "moderate"
            }
          ],
          "edges": [
            {
              "source": "file:src/main.swift",
              "target": "class:src/Foo.swift:Foo",
              "type": "imports",
              "direction": "forward",
              "weight": 0.8
            }
          ],
          "layers": [
            {
              "id": "layer-core",
              "name": "Core",
              "description": "Core module",
              "nodeIds": ["file:src/main.swift"]
            }
          ],
          "tour": [
            {
              "order": 1,
              "title": "Start here",
              "description": "Begin with main",
              "nodeIds": ["file:src/main.swift"],
              "languageLesson": "Swift entry points use @main"
            }
          ]
        }
        """.data(using: .utf8)!

        let parsed = try UAParser.parse(data: json, repoRoot: repoRoot)
        #expect(parsed.nodes.count == 2)
        #expect(parsed.edges.count == 1)
        #expect(parsed.layers.count == 1)
        #expect(parsed.tour.count == 1)

        let file = parsed.nodes.first { $0.id == "file:src/main.swift" }!
        #expect(file.title == "main.swift")
        #expect(file.kind == .file)
        #expect(file.metadata["fileURL"] == "file:///repo/src/main.swift")
        #expect(file.metadata["summary"] == "Entry point")
        #expect(file.metadata["complexity"] == "simple")
        #expect(file.metadata["tags"] == "entry")

        let cls = parsed.nodes.first { $0.id == "class:src/Foo.swift:Foo" }!
        #expect(cls.kind == .classType)
        #expect(cls.metadata["line"] == "L10-L50")

        let edge = parsed.edges.first!
        #expect(edge.kind == .imports)

        let layer = parsed.layers.first!
        #expect(layer.name == "Core")
        #expect(layer.nodeIds == ["file:src/main.swift"])

        let tourStep = parsed.tour.first!
        #expect(tourStep.title == "Start here")
        #expect(tourStep.languageLesson == "Swift entry points use @main")
    }

    @Test func mapsNodeTypeAliases() {
        #expect(UAParser.mapNodeType("func") == .function)
        #expect(UAParser.mapNodeType("method") == .function)
        #expect(UAParser.mapNodeType("struct") == .classType)
        #expect(UAParser.mapNodeType("interface") == .classType)
        #expect(UAParser.mapNodeType("package") == .module)
        #expect(UAParser.mapNodeType("doc") == .docPage)
        #expect(UAParser.mapNodeType("api") == .endpoint)
        #expect(UAParser.mapNodeType("workflow") == .pipeline)
        #expect(UAParser.mapNodeType("database") == .table)
    }

    @Test func mapsEdgeTypeAliases() {
        #expect(UAParser.mapEdgeType("extends") == .inherits)
        #expect(UAParser.mapEdgeType("invokes") == .calls)
        #expect(UAParser.mapEdgeType("uses") == .dependsOn)
        #expect(UAParser.mapEdgeType("tests") == .testedBy)
        #expect(UAParser.mapEdgeType("emits") == .publishes)
        #expect(UAParser.mapEdgeType("reads") == .readsFrom)
    }

    @Test func unknownEdgeTypeFallsBackToRelatedTo() throws {
        let json = """
        {"version": "1.0.0",
         "project": {"name":"t","languages":[],"frameworks":[],"description":"t","analyzedAt":"2026-01-01T00:00:00Z","gitCommitHash":"x"},
         "nodes": [
           {"id": "a", "type": "file", "name": "A", "summary": "", "tags": [], "complexity": "simple"},
           {"id": "b", "type": "file", "name": "B", "summary": "", "tags": [], "complexity": "simple"}
         ],
         "edges": [{"source": "a", "target": "b", "type": "teleports"}],
         "layers": [], "tour": []}
        """.data(using: .utf8)!
        let parsed = try UAParser.parse(data: json, repoRoot: repoRoot)
        #expect(parsed.edges.first?.kind == .relatedTo)
    }

    @Test func missingNodesKeyThrowsParseFailed() {
        let json = #"{"version": "1.0.0"}"#.data(using: .utf8)!
        #expect(throws: UAError.self) {
            try UAParser.parse(data: json, repoRoot: repoRoot)
        }
    }

    @Test func emptyNodesArrayParsesCleanly() throws {
        let json = """
        {"version": "1.0.0",
         "project": {"name":"t","languages":[],"frameworks":[],"description":"t","analyzedAt":"2026-01-01T00:00:00Z","gitCommitHash":"x"},
         "nodes": [], "edges": [], "layers": [], "tour": []}
        """.data(using: .utf8)!
        let parsed = try UAParser.parse(data: json, repoRoot: repoRoot)
        #expect(parsed.nodes.isEmpty)
        #expect(parsed.edges.isEmpty)
    }

    @Test func resolvesRelativeFilePath() {
        let root = URL(fileURLWithPath: "/my/repo")
        let resolved = UAParser.resolveFileURL(filePath: "src/main.swift", repoRoot: root)
        #expect(resolved.path == "/my/repo/src/main.swift")
    }

    @Test func resolvesAbsoluteFilePathInsideRepo() {
        let root = URL(fileURLWithPath: "/my/repo")
        let resolved = UAParser.resolveFileURL(filePath: "/my/repo/src/main.swift", repoRoot: root)
        #expect(resolved.path == "/my/repo/src/main.swift")
    }

    @Test func rebasesStaleAbsolutePath() {
        let root = URL(fileURLWithPath: "/new/location/repo")
        let resolved = UAParser.resolveFileURL(filePath: "/old/location/repo/src/main.swift", repoRoot: root)
        #expect(resolved.path == "/new/location/repo/src/main.swift")
    }

    @Test func defaultsNilTypeToFile() {
        #expect(UAParser.mapNodeType(nil) == .file)
    }

    @Test func unknownNodeTypeFallsBackToOther() {
        #expect(UAParser.mapNodeType("alien") == .other)
    }
}
```

- [ ] **Step 2: Create UAInstallerTests.swift**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct UAInstallerTests {
    final class MockLauncher: ProcessLauncher, @unchecked Sendable {
        var capturedExecutable: URL?
        var capturedArgs: [String] = []
        var exitCode: Int32 = 0
        var stdout: Data = Data()
        var stderr: Data = Data()

        func run(executable: URL, arguments: [String], environment: [String: String]?) async throws -> (Int32, Data, Data) {
            capturedExecutable = executable
            capturedArgs = arguments
            return (exitCode, stdout, stderr)
        }
    }

    @Test func mapsClaudeCodeToPlatformClaude() async throws {
        let launcher = MockLauncher()
        let installer = UAInstaller(launcher: launcher, npxURL: URL(fileURLWithPath: "/fake/npx"))
        _ = try await installer.install(cli: .claudeCode).get()
        #expect(launcher.capturedArgs == ["understand-anything", "install", "--platform", "claude"])
    }

    @Test func mapsCursorToPlatformCursor() async throws {
        let launcher = MockLauncher()
        let installer = UAInstaller(launcher: launcher, npxURL: URL(fileURLWithPath: "/fake/npx"))
        _ = try await installer.install(cli: .cursor).get()
        #expect(launcher.capturedArgs == ["understand-anything", "install", "--platform", "cursor"])
    }

    @Test func mapsGeminiToPlatformGemini() async throws {
        let launcher = MockLauncher()
        let installer = UAInstaller(launcher: launcher, npxURL: URL(fileURLWithPath: "/fake/npx"))
        _ = try await installer.install(cli: .gemini).get()
        #expect(launcher.capturedArgs == ["understand-anything", "install", "--platform", "gemini"])
    }

    @Test func mapsCopilotToPlatformCodex() async throws {
        let launcher = MockLauncher()
        let installer = UAInstaller(launcher: launcher, npxURL: URL(fileURLWithPath: "/fake/npx"))
        _ = try await installer.install(cli: .copilot).get()
        #expect(launcher.capturedArgs == ["understand-anything", "install", "--platform", "codex"])
    }

    @Test func returnsBinaryMissingWhenNpxUnavailable() async {
        let installer = UAInstaller(launcher: MockLauncher(), npxURL: nil)
        let result = await installer.install(cli: .claudeCode)
        #expect(result == .failure(.binaryMissing))
    }

    @Test func returnsRunFailedOnNonZeroExit() async {
        let launcher = MockLauncher()
        launcher.exitCode = 2
        launcher.stderr = Data("nope\n".utf8)
        let installer = UAInstaller(launcher: launcher, npxURL: URL(fileURLWithPath: "/fake/npx"))
        let result = await installer.install(cli: .claudeCode)
        guard case .failure(.runFailed(let code, let tail)) = result else {
            Issue.record("expected runFailed, got \(result)"); return
        }
        #expect(code == 2)
        #expect(tail.contains("nope"))
    }
}
```

- [ ] **Step 3: Delete old test files**

```bash
git rm mac/Tests/MeetNotesMacTests/GraphifyParserTests.swift
git rm mac/Tests/MeetNotesMacTests/GraphifyParserPathTests.swift
git rm mac/Tests/MeetNotesMacTests/GraphifyInstallerTests.swift
```

- [ ] **Step 4: Update MemoryStoreTests.swift**

Replace `"graphify-out/memory"` with `".understand-anything/memory"` in all assertions and setup code.

- [ ] **Step 5: Update MemoryStoreWritesTests.swift**

Replace `"graphify-out/memory"` with `".understand-anything/memory"` in all path assertions.

- [ ] **Step 6: Update MemoryNotesWriterTests.swift**

Update any assertion checking the header text from `"Graphify"` to `"Understand-Anything"` and `"graphify update"` to `"understand-anything analyze"`.

- [ ] **Step 7: Run all tests**

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test 2>&1 | tail -20`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A mac/Tests/
git commit -m "test: rewrite parser/installer tests for UA, update memory test paths"
```

---

## Task 11: Build verification and fix compile errors

**Files:**
- Potentially any file from Tasks 1-10

- [ ] **Step 1: Full release build**

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build -c release 2>&1 | grep -E 'error:|Build'`

- [ ] **Step 2: Fix any remaining compile errors**

Common issues to watch for:
- Any file still referencing `GraphifyRunner`, `GraphifyParser`, `GraphifyStore`, `GraphifyInstaller`, `GraphifyError`, `GraphifyHelpers`, `GraphifyView`
- Any file still referencing `.graphify` section case (now `.codeGraph`)
- Any file still referencing `graphifyBinaryOverride` (now `uaBinaryOverride`)
- Missing switch cases for new `CGNodeKind` or `CGEdgeKind` values

Fix each error by updating the reference to the new name.

- [ ] **Step 3: Run all tests again**

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test 2>&1 | tail -10`

Expected: All tests pass.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A mac/
git commit -m "fix: resolve remaining compile errors from graphify→UA migration"
```

---

## Task 12: Update gitignore and Claude Code skill

**Files:**
- Modify: `mac/.gitignore`
- Modify: `~/.claude/CLAUDE.md`

- [ ] **Step 1: Update mac/.gitignore**

Replace line 18: `graphify-out/` → `.understand-anything/`

- [ ] **Step 2: Update ~/.claude/CLAUDE.md**

Replace the graphify skill block:
```
# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, invoke the Skill tool with `skill: "graphify"` before doing anything else.
```

With:
```
# understand-anything
- **understand-anything** — codebase to interactive knowledge graph. Trigger: `/understand`
When the user types `/understand`, run the Understand-Anything plugin to analyze the codebase.
```

- [ ] **Step 3: Delete old graphify-out data**

```bash
rm -rf /Users/dinesh.malla/Desktop/meet-notes/mac/graphify-out/
```

- [ ] **Step 4: Commit**

```bash
git add mac/.gitignore
git commit -m "chore: update gitignore for .understand-anything/, remove graphify-out"
```

---

## Task 13: Final integration test — build and launch

- [ ] **Step 1: Clean build**

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift build -c release 2>&1 | tail -5`

Expected: `Build of product 'MeetNotesMac' complete!`

- [ ] **Step 2: Run test suite**

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && swift test 2>&1 | tail -10`

Expected: All tests pass.

- [ ] **Step 3: Build the app bundle**

Run: `cd /Users/dinesh.malla/Desktop/meet-notes/mac && bash Scripts/build.sh 2>&1 | tail -5`

Expected: `[build] ok — /Users/dinesh.malla/Desktop/meet-notes/mac/MeetNotesMac.app`

- [ ] **Step 4: Launch the app**

Run: `open /Users/dinesh.malla/Desktop/meet-notes/mac/MeetNotesMac.app`

Verify: App launches without crash. Navigate to Code Graph section — should show the install prompt for Understand-Anything (since no analysis has been run yet).

- [ ] **Step 5: Final commit if any remaining changes**

```bash
git add -A
git commit -m "chore: graphify → understand-anything migration complete"
git push origin main
```
