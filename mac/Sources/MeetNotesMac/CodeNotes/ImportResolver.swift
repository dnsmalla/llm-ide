import Foundation

/// Resolves a RawImport to a repo-internal file path, or nil if it points
/// outside the repo (external package). Pure and deterministic.
public enum ImportResolver {

    public static func resolve(_ imp: RawImport, fromFile: String,
                               language: String, files: Set<String>) -> String? {
        switch language {
        case "python":     return resolvePython(imp, files: files)
        case "typescript", "javascript": return resolveJS(imp, fromFile: fromFile, files: files)
        default:           return nil   // swift/other: no file-level import edges
        }
    }

    // MARK: - Python

    private static func resolvePython(_ imp: RawImport, files: Set<String>) -> String? {
        // Candidates from most to least specific. For `from a.b import c`:
        //   a/b/c.py, a/b/c/__init__.py (c is a submodule), then a/b.py, a/b/__init__.py.
        var dotted = [String]()
        if let name = imp.name, !name.isEmpty {
            dotted.append(imp.module.isEmpty ? name : imp.module + "." + name)
        }
        if !imp.module.isEmpty { dotted.append(imp.module) }

        for d in dotted {
            let base = d.split(separator: ".").joined(separator: "/")
            for cand in ["\(base).py", "\(base)/__init__.py"] where files.contains(cand) {
                return cand
            }
        }
        return nil
    }

    // MARK: - TS / JS

    private static func resolveJS(_ imp: RawImport, fromFile: String, files: Set<String>) -> String? {
        let spec = imp.module
        // Only resolve relative specifiers; bare packages are external.
        guard spec.hasPrefix("./") || spec.hasPrefix("../") else { return nil }

        let dir = (fromFile as NSString).deletingLastPathComponent
        let combined = normalize(joining: dir, spec)

        let exts = ["ts", "tsx", "js", "jsx"]
        // Direct file with extension.
        for e in exts where files.contains("\(combined).\(e)") { return "\(combined).\(e)" }
        // Directory index.
        for e in exts where files.contains("\(combined)/index.\(e)") { return "\(combined)/index.\(e)" }
        // Already has an extension and exists.
        if files.contains(combined) { return combined }
        return nil
    }

    /// Resolve a relative path against a base directory, collapsing . and ..
    static func normalize(joining base: String, _ rel: String) -> String {
        var parts = base.isEmpty ? [] : base.split(separator: "/").map(String.init)
        for comp in rel.split(separator: "/").map(String.init) {
            if comp == "." || comp.isEmpty { continue }
            else if comp == ".." { if !parts.isEmpty { parts.removeLast() } }
            else { parts.append(comp) }
        }
        return parts.joined(separator: "/")
    }
}
