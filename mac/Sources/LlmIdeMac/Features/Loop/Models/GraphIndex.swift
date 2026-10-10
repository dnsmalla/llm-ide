import Foundation

/// Read-only view of `<gitRoot>/system/graph/graph.json` (written by the CodeGraph feature).
/// Own Codable so Features/Loop never imports CodeGraph/GraphCore.
/// graph.json 1.1 adds `calls` (file-level call edges) and `files[].role`; 1.0 files decode unchanged.
struct GraphIndex: Codable {
    struct Sym: Codable { var name: String; var line: Int; var declaration: String? }
    struct File: Codable {
        var path: String; var language: String; var loc: Int
        var role: String?
        var imports: [String]; var usedBy: [String]
        var types: [Sym]; var functions: [Sym]

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = try c.decode(String.self, forKey: .path)
            language = try c.decode(String.self, forKey: .language)
            loc = try c.decode(Int.self, forKey: .loc)
            role = try c.decodeIfPresent(String.self, forKey: .role)
            imports = try c.decodeIfPresent([String].self, forKey: .imports) ?? []
            usedBy = try c.decodeIfPresent([String].self, forKey: .usedBy) ?? []
            types = try c.decodeIfPresent([Sym].self, forKey: .types) ?? []
            functions = try c.decodeIfPresent([Sym].self, forKey: .functions) ?? []
        }
    }
    /// One file-level call: `from` (caller file) calls `symbol` defined in `to` (callee file).
    struct Call: Codable, Equatable { var from: String; var to: String; var symbol: String }

    var version: String
    var files: [File]
    var calls: [Call]

    init(version: String, files: [File], calls: [Call] = []) {
        self.version = version; self.files = files; self.calls = calls
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(String.self, forKey: .version)
        files = try c.decode([File].self, forKey: .files)
        calls = try c.decodeIfPresent([Call].self, forKey: .calls) ?? []
    }

    /// Files that call into `path`.
    func callerFiles(of path: String) -> Set<String> {
        Set(calls.filter { $0.to == path }.map(\.from))
    }

    /// Files that `path` calls into.
    func calleeFiles(of path: String) -> Set<String> {
        Set(calls.filter { $0.from == path }.map(\.to))
    }

    static func load(gitRoot: URL) -> GraphIndex? {
        let url = gitRoot.appendingPathComponent("system/graph/graph.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        do { return try JSONDecoder().decode(GraphIndex.self, from: data) }
        catch { NSLog("GraphIndex: graph.json could not be decoded: \(error)"); return nil }
    }
}
