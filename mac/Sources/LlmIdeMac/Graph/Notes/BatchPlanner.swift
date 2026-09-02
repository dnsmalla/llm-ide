import Foundation

/// A group of source files to enrich together, plus each file's direct import
/// neighbors (including ones in other batches, so cross-batch context survives).
public struct CodeBatch: Equatable {
    public let index: Int
    public let files: [String]
    public let neighbors: [String: [String]]

    public init(index: Int, files: [String], neighbors: [String: [String]]) {
        self.index = index
        self.files = files
        self.neighbors = neighbors
    }
}

/// Groups source files into batches for note generation. Import-connected files
/// are placed in the same batch (so an enrichment agent sees related code
/// together), subject to a `maxBatchSize` cap.
public enum BatchPlanner {
    public static func plan(files: [String], imports: [String: [String]], maxBatchSize: Int) -> [CodeBatch] {
        guard !files.isEmpty else { return [] }
        let cap = max(1, maxBatchSize)

        // Undirected adjacency over the known file set (ignore imports of files
        // not in `files`, e.g. external modules).
        let known = Set(files)
        var adjacency: [String: Set<String>] = [:]
        for file in files { adjacency[file] = [] }
        for file in files {
            for target in imports[file] ?? [] where known.contains(target) {
                adjacency[file, default: []].insert(target)
                adjacency[target, default: []].insert(file)
            }
        }

        // Connected components, discovered in input order with sorted expansion
        // for deterministic output.
        var visited: Set<String> = []
        var batches: [CodeBatch] = []
        for seed in files where !visited.contains(seed) {
            var component: [String] = []
            var queue = [seed]
            visited.insert(seed)
            while !queue.isEmpty {
                let node = queue.removeFirst()
                component.append(node)
                for next in (adjacency[node] ?? []).sorted() where !visited.contains(next) {
                    visited.insert(next)
                    queue.append(next)
                }
            }
            // Split an oversized component into cap-sized chunks (BFS order keeps
            // each chunk locally cohesive).
            for chunkStart in stride(from: 0, to: component.count, by: cap) {
                let chunk = Array(component[chunkStart..<min(chunkStart + cap, component.count)])
                let neighbors = chunk.reduce(into: [String: [String]]()) { acc, file in
                    acc[file] = (adjacency[file] ?? []).sorted()
                }
                batches.append(CodeBatch(index: batches.count, files: chunk, neighbors: neighbors))
            }
        }
        return batches
    }
}
