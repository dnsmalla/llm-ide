// Parses understand-anything's `knowledge-graph.json` into the local CGData type.
//
// UA schema (v1.0.0):
//
//   {
//     "version": "1.0.0",
//     "nodes": [
//       {
//         "id": "file:path",
//         "type": "file",
//         "name": "...",
//         "filePath": "...",
//         "lineRange": [10, 50],
//         "summary": "...",
//         "tags": ["..."],
//         "complexity": "simple"
//       }, ...
//     ],
//     "edges": [
//       {
//         "source": "...",
//         "target": "...",
//         "type": "imports",
//         "direction": "forward",
//         "weight": 0.8
//       }, ...
//     ],
//     "layers": [
//       { "id": "...", "name": "...", "description": "...", "nodeIds": ["..."] }
//     ],
//     "tour": [
//       { "order": 1, "title": "...", "description": "...", "nodeIds": ["..."], "languageLesson": "..." }
//     ]
//   }

import Foundation
import CoreGraphics

public enum UAParser {

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
        let name: String?
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
        let weight: Double?
    }

    private struct RawLayer: Decodable {
        let id: String
        let name: String
        let description: String?
        let nodeIds: [String]
    }

    private struct RawTourStep: Decodable {
        let order: Int?
        let title: String?
        let description: String?
        let nodeIds: [String]?
        let languageLesson: String?
    }

    // MARK: - Public entry point

    /// Decode understand-anything's `knowledge-graph.json`. `repoRoot` is
    /// used to convert UA's relative `filePath` values into absolute file
    /// URLs so the canvas can launch files on double-click.
    public static func parse(data: Data, repoRoot: URL) throws -> CGData {
        let raw: RawGraph
        do {
            raw = try AppJSON.decoder.decode(RawGraph.self, from: data)
        } catch {
            throw UAError.parseFailed(message: error.localizedDescription)
        }

        // Check for an unsupported schema version. We only require `nodes`
        // to be present; a `version` mismatch is surfaced as a warning via
        // `.unsupportedSchema` rather than a hard failure, but we still
        // parse what we can. Currently we accept any version.
        guard let rawNodes = raw.nodes else {
            throw UAError.parseFailed(message: "knowledge-graph.json had no `nodes` field")
        }
        let rawEdges = raw.edges ?? []
        let rawLayers = raw.layers ?? []
        let rawTour = raw.tour ?? []

        let nodes: [CGNode] = rawNodes.map { rn in
            let kind = mapNodeType(rn.type)
            var meta: [String: String] = [:]

            if let fp = rn.filePath, !fp.isEmpty {
                let abs = resolveFileURL(filePath: fp, repoRoot: repoRoot)
                meta["fileURL"] = abs.absoluteString
                // Store path relative to repoRoot so the detail panel shows
                // a clean relative path, not stale absolutes.
                let rootPath = repoRoot.standardizedFileURL.path
                let absPath = abs.standardizedFileURL.path
                if absPath.hasPrefix(rootPath + "/") {
                    meta["source_file"] = String(absPath.dropFirst(rootPath.count + 1))
                } else {
                    meta["source_file"] = fp
                }
            }

            if let lr = rn.lineRange, lr.count >= 2 {
                meta["line"] = "L\(lr[0])-L\(lr[1])"
            } else if let lr = rn.lineRange, lr.count == 1 {
                meta["line"] = "L\(lr[0])"
            }

            if let summary = rn.summary, !summary.isEmpty { meta["summary"] = summary }
            if let complexity = rn.complexity, !complexity.isEmpty { meta["complexity"] = complexity }
            if let tags = rn.tags, !tags.isEmpty { meta["tags"] = tags.joined(separator: ", ") }
            if let t = rn.type, !t.isEmpty { meta["ua_type"] = t }

            let title = rn.name ?? rn.id
            return CGNode(id: rn.id, title: title, kind: kind, position: .zero, metadata: meta)
        }

        let edges: [CGEdge] = rawEdges.map { re in
            CGEdge(fromId: re.source, toId: re.target, kind: mapEdgeType(re.type))
        }

        let layers: [UALayer] = rawLayers.map { rl in
            UALayer(id: rl.id, name: rl.name, nodeIds: rl.nodeIds)
        }

        // Sort tour steps by `order` so they're in canonical sequence.
        let sortedTour = rawTour.sorted { ($0.order ?? 0) < ($1.order ?? 0) }
        let tour: [UATourStep] = sortedTour.compactMap { rt in
            guard let nodeId = rt.nodeIds?.first else { return nil }
            let title = rt.title ?? "Step \(rt.order ?? 0)"
            let body = rt.description ?? rt.languageLesson ?? ""
            return UATourStep(nodeId: nodeId, title: title, body: body)
        }

        return CGData(nodes: nodes, edges: edges, layers: layers, tour: tour)
    }

    // MARK: - Type mapping (static for testability)

    /// Map a UA node type string to a CGNodeKind. Includes an alias table
    /// for UA's type vocabulary.
    public static func mapNodeType(_ raw: String?) -> CGNodeKind {
        switch (raw ?? "file").lowercased() {
        // Direct mappings
        case "file":                    return .file
        case "module", "package":       return .module
        case "document", "doc":         return .docPage
        case "function", "func":        return .function
        case "class", "struct":         return .classType
        case "config", "configuration": return .config
        case "service":                 return .service
        case "table":                   return .table
        case "endpoint", "api":         return .endpoint
        case "pipeline":                return .pipeline
        case "schema":                  return .schemaNode
        case "resource":                return .resource
        case "domain":                  return .domain
        case "flow":                    return .flow
        case "step":                    return .step
        case "article":                 return .article
        case "entity":                  return .entity
        case "topic":                   return .topic
        case "claim":                   return .claim
        // Aliases
        case "symbol", "method", "interface": return .symbol
        case "":                        return .other
        default:                        return .other
        }
    }

    /// Map a UA edge type string to a CGEdgeKind. Includes an alias table
    /// for UA's edge vocabulary.
    public static func mapEdgeType(_ raw: String) -> CGEdgeKind {
        switch raw.lowercased() {
        // Direct mappings
        case "imports":                 return .imports
        case "exports":                 return .exports
        case "contains":                return .contains
        case "inherits":                return .inherits
        case "implements":              return .implements
        case "calls":                   return .calls
        case "subscribes":              return .subscribes
        case "publishes":               return .publishes
        case "middleware":              return .middleware
        case "reads_from", "readsfrom": return .readsFrom
        case "writes_to", "writesto":   return .writesTo
        case "transforms":              return .transforms
        case "validates":               return .validates
        case "depends_on", "dependson": return .dependsOn
        case "tested_by", "testedby":   return .testedBy
        case "configures":              return .configures
        case "related_to", "relatedto": return .relatedTo
        case "similar_to", "similarto": return .similarTo
        case "deploys":                 return .deploys
        case "serves":                  return .serves
        case "provisions":              return .provisions
        case "triggers":                return .triggers
        case "migrates":                return .migrates
        case "documents":               return .documents
        case "routes":                  return .routes
        case "defines_schema":          return .definesSchema
        case "contains_flow":           return .containsFlow
        case "flow_step":               return .flowStep
        case "cross_domain":            return .crossDomain
        case "cites":                   return .cites
        case "contradicts":             return .contradicts
        case "builds_on", "buildson":   return .buildsOn
        case "exemplifies":             return .exemplifies
        case "categorized_under":       return .categorizedUnder
        case "authored_by":             return .authoredBy
        // Aliases from UA's alias table
        case "extends", "extends_from": return .inherits
        case "invokes":                 return .calls
        case "uses", "requires":        return .dependsOn
        case "tests":                   return .testedBy
        case "emits":                   return .publishes
        case "listens":                 return .subscribes
        case "reads":                   return .readsFrom
        case "writes":                  return .writesTo
        case "opposes":                 return .contradicts
        case "extends_idea":            return .buildsOn
        case "illustrates":             return .exemplifies
        case "tagged":                  return .categorizedUnder
        case "written_by":              return .authoredBy
        case "references":              return .references
        case "defines", "method", "case_of": return .defines
        default:                        return .relatedTo
        }
    }

    /// Resolve `filePath` (from understand-anything CLI) to an absolute file
    /// URL rooted at the current `repoRoot`. Handles three shapes:
    ///
    ///   - Relative ("Sources/Foo/Bar.swift") — appended to repoRoot.
    ///   - Absolute inside repoRoot — used as-is.
    ///   - Absolute at a different (stale) location — rebased by finding
    ///     the last occurrence of repoRoot's last path component.
    ///
    /// The rebasing logic matches UAParser's behaviour for continuity.
    public static func resolveFileURL(filePath: String, repoRoot: URL) -> URL {
        if !filePath.hasPrefix("/") {
            return repoRoot.appendingPathComponent(filePath, isDirectory: false)
        }
        let rootPath = repoRoot.standardizedFileURL.path
        if filePath.hasPrefix(rootPath + "/") || filePath == rootPath {
            return URL(fileURLWithPath: filePath)
        }
        // Stale absolute — try to rebase by finding the last occurrence of
        // the repo's directory name in the path.
        let repoName = repoRoot.lastPathComponent
        let needle = "/\(repoName)/"
        if let range = filePath.range(of: needle, options: .backwards) {
            let tail = String(filePath[range.upperBound...])
            return repoRoot.appendingPathComponent(tail, isDirectory: false)
        }
        return URL(fileURLWithPath: filePath)
    }
}
