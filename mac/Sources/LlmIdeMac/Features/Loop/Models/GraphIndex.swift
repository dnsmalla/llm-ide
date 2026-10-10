import Foundation

/// Read-only view of `<gitRoot>/system/graph/graph.json` (written by the CodeGraph feature).
/// Own Codable so Features/Loop never imports CodeGraph/GraphCore.
struct GraphIndex: Codable {
    struct Sym: Codable { var name: String; var line: Int; var declaration: String? }
    struct File: Codable {
        var path: String; var language: String; var loc: Int
        var imports: [String]; var usedBy: [String]
        var types: [Sym]; var functions: [Sym]
    }
    var version: String
    var files: [File]

    static func load(gitRoot: URL) -> GraphIndex? {
        let url = gitRoot.appendingPathComponent("system/graph/graph.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(GraphIndex.self, from: data)
    }
}
