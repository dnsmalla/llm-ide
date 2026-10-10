import Foundation

/// Read-only view of `<gitRoot>/system/graph/graph.json` (written by the CodeGraph feature).
/// Own Codable so Features/Loop never imports CodeGraph/GraphCore.
struct GraphIndex: Codable {
    struct Sym: Codable { var name: String; var line: Int; var declaration: String? }
    struct File: Codable {
        var path: String; var language: String; var loc: Int
        var imports: [String]; var usedBy: [String]
        var types: [Sym]; var functions: [Sym]

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = try c.decode(String.self, forKey: .path)
            language = try c.decode(String.self, forKey: .language)
            loc = try c.decode(Int.self, forKey: .loc)
            imports = try c.decodeIfPresent([String].self, forKey: .imports) ?? []
            usedBy = try c.decodeIfPresent([String].self, forKey: .usedBy) ?? []
            types = try c.decodeIfPresent([Sym].self, forKey: .types) ?? []
            functions = try c.decodeIfPresent([Sym].self, forKey: .functions) ?? []
        }
    }
    var version: String
    var files: [File]

    static func load(gitRoot: URL) -> GraphIndex? {
        let url = gitRoot.appendingPathComponent("system/graph/graph.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        do { return try JSONDecoder().decode(GraphIndex.self, from: data) }
        catch { NSLog("GraphIndex: graph.json could not be decoded: \(error)"); return nil }
    }
}
