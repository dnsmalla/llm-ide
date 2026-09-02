import Foundation
import GraphCore

/// Deterministic synthetic graphs shaped like the ones this pipeline really
/// produces, so the benchmark can exercise scales and densities on demand
/// without needing a repo to scan.
///
/// The shape matters more than the size. A real code graph is not a random
/// graph: it has modules whose files import each other far more often than they
/// import across module boundaries, a heavy-tailed import degree distribution
/// (a handful of files are imported by hundreds), file→symbol containment stars,
/// and — once docs are merged in — a large volume of low-confidence
/// `relatedTo` edges from title matching. All four are reproduced here, because
/// each one broke the old layout in a different way.
enum SyntheticGraph {

    /// Small deterministic PRNG so graphs are reproducible across runs and
    /// machines without depending on the platform's RNG.
    struct Random {
        private var state: UInt64
        init(seed: UInt64) { self.state = seed == 0 ? 0x9E3779B97F4A7C15 : seed }
        mutating func next() -> UInt64 {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            return state
        }
        mutating func double() -> Double { Double(next() % 1_000_000) / 1_000_000 }
        mutating func int(_ range: Range<Int>) -> Int {
            guard range.count > 0 else { return range.lowerBound }
            return range.lowerBound + Int(next() % UInt64(range.count))
        }
    }

    /// A codebase: `modules` folders, each with files, each with symbols.
    /// Imports are mostly intra-module; a few files are global hubs.
    static func codebase(modules: Int, filesPerModule: Int,
                         symbolsPerFile: Int, seed: UInt64 = 42) -> CGData {
        var random = Random(seed: seed)
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        var filesByModule: [[String]] = []

        for module in 0..<modules {
            var moduleFiles: [String] = []
            for file in 0..<filesPerModule {
                let path = "src/module\(module)/file\(file).swift"
                let fileId = "file:\(path)"
                nodes.append(CGNode(id: fileId, title: "file\(file).swift", kind: .file,
                                    metadata: ["source_file": path, "language": "swift",
                                               "loc": String(random.int(30..<600))]))
                moduleFiles.append(fileId)

                for symbol in 0..<symbolsPerFile {
                    let symbolId = "function:\(path):fn\(symbol)"
                    nodes.append(CGNode(id: symbolId, title: "fn\(module)_\(file)_\(symbol)",
                                        kind: symbol == 0 ? .classType : .function,
                                        metadata: ["source_file": path,
                                                   "line": "L\(symbol * 12 + 3)"]))
                    // Containment: emitted first, exactly as StructureGraphBuilder
                    // does — which is what let capDegree(6) consume every node's
                    // whole budget before a single import edge was considered.
                    edges.append(CGEdge(fromId: fileId, toId: symbolId,
                                        kind: .contains, confidence: .extracted))
                }
            }
            filesByModule.append(moduleFiles)
        }

        // Import edges: 80% within the module, 20% across. A few designated hubs
        // attract a disproportionate share, producing the heavy tail.
        let allFiles = filesByModule.flatMap { $0 }
        let hubCount = max(1, allFiles.count / 40)
        let hubs = (0..<hubCount).map { allFiles[($0 * 7 + 3) % allFiles.count] }

        for (module, moduleFiles) in filesByModule.enumerated() {
            for file in moduleFiles {
                let importCount = random.int(1..<6)
                for _ in 0..<importCount {
                    let target: String
                    if random.double() < 0.22 {
                        target = hubs[random.int(0..<hubs.count)]
                    } else if random.double() < 0.8 {
                        target = moduleFiles[random.int(0..<moduleFiles.count)]
                    } else {
                        let otherModule = filesByModule[random.int(0..<filesByModule.count)]
                        target = otherModule[random.int(0..<otherModule.count)]
                    }
                    guard target != file else { continue }
                    edges.append(CGEdge(fromId: file, toId: target,
                                        kind: .imports, confidence: .extracted))
                }
                _ = module
            }
        }

        // Symbol-level calls, mostly intra-module, INFERRED as the real scanner
        // marks them.
        let symbolIds = nodes.filter { $0.kind == .function }.map(\.id)
        if symbolIds.count > 2 {
            for _ in 0..<(symbolIds.count / 2) {
                let from = symbolIds[random.int(0..<symbolIds.count)]
                let to = symbolIds[random.int(0..<symbolIds.count)]
                guard from != to else { continue }
                edges.append(CGEdge(fromId: from, toId: to,
                                    kind: .calls, confidence: .inferred))
            }
        }

        return CGData(nodes: nodes, edges: edges)
    }

    /// A doc graph with the noise profile `MemoryGenerator` produces: chunk→doc
    /// links plus a large volume of `relatedTo`/`AMBIGUOUS` title matches, the
    /// pattern that once yielded ~702k edges over 11k nodes.
    static func docSet(docs: Int, chunksPerDoc: Int,
                       noisePerChunk: Int, seed: UInt64 = 7) -> CGData {
        var random = Random(seed: seed)
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        var chunkIds: [String] = []

        for doc in 0..<docs {
            let docId = "doc:\(doc)"
            nodes.append(CGNode(id: docId, title: "doc\(doc).md", kind: .memoryDoc,
                                metadata: ["source_file": "docs/doc\(doc).md"]))
            for chunk in 0..<chunksPerDoc {
                let chunkId = "chunk:\(doc):\(chunk)"
                nodes.append(CGNode(id: chunkId, title: "Section \(chunk)",
                                    kind: .memoryChunk,
                                    metadata: ["doc": "doc\(doc).md"]))
                chunkIds.append(chunkId)
                // doc `contains` chunk — parent→child, matching the corrected
                // `MemoryGenerator`. It used to emit `chunk → doc` as
                // `.relatedTo`, which made a document's backbone
                // indistinguishable from title-match noise.
                edges.append(CGEdge(fromId: docId, toId: chunkId,
                                    kind: .contains, confidence: .extracted))
            }
        }

        // Real authored cross-references — the signal inside the noise.
        for chunk in chunkIds where random.double() < 0.15 {
            let target = chunkIds[random.int(0..<chunkIds.count)]
            guard target != chunk else { continue }
            edges.append(CGEdge(fromId: chunk, toId: target,
                                kind: .references, confidence: .extracted))
        }
        // Title-match noise.
        for chunk in chunkIds {
            for _ in 0..<noisePerChunk {
                let target = chunkIds[random.int(0..<chunkIds.count)]
                guard target != chunk else { continue }
                edges.append(CGEdge(fromId: chunk, toId: target,
                                    kind: .relatedTo, confidence: .ambiguous))
            }
        }
        return CGData(nodes: nodes, edges: edges)
    }

    /// Many tiny disconnected components — a repository whose imports never
    /// resolved, which is what the code graph really looked like after the old
    /// degree cap ran (867 components). Each component is a small star.
    static func fragmented(components: Int, sizePerComponent: Int = 4,
                           seed: UInt64 = 99) -> CGData {
        var random = Random(seed: seed)
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        for component in 0..<components {
            let hub = "file:c\(component)/hub.swift"
            nodes.append(CGNode(id: hub, title: "hub\(component).swift", kind: .file,
                                metadata: ["source_file": "c\(component)/hub.swift"]))
            for leaf in 0..<max(1, sizePerComponent - 1) {
                let id = "function:c\(component)/hub.swift:fn\(leaf)"
                nodes.append(CGNode(id: id, title: "fn\(component)_\(leaf)",
                                    kind: .function))
                edges.append(CGEdge(fromId: hub, toId: id, kind: .contains,
                                    confidence: .extracted))
            }
            _ = random.next()
        }
        return CGData(nodes: nodes, edges: edges)
    }

    /// Merge two graphs and add doc→code links, as `KnowledgeGraphService.merge`
    /// does, so the "All" mode's mixed shape can be measured too.
    static func merged(code: CGData, doc: CGData, seed: UInt64 = 11) -> CGData {
        var random = Random(seed: seed)
        let codeIds = code.nodes.filter { $0.kind == .file }.map(\.id)
        let chunkIds = doc.nodes.filter { $0.kind == .memoryChunk }.map(\.id)
        var crossLinks: [CGEdge] = []
        guard !codeIds.isEmpty, !chunkIds.isEmpty else {
            return CGData(nodes: code.nodes + doc.nodes, edges: code.edges + doc.edges)
        }
        for chunk in chunkIds where random.double() < 0.3 {
            let target = codeIds[random.int(0..<codeIds.count)]
            crossLinks.append(CGEdge(fromId: chunk, toId: target,
                                     kind: .documents, confidence: .inferred))
        }
        return CGData(nodes: code.nodes + doc.nodes,
                      edges: code.edges + doc.edges + crossLinks)
    }
}
