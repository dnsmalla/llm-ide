import Foundation
/// Minimal glob → matches a repo-relative path. Supports `*` (any within a
/// segment), `**` (any incl. /), `?`, and a bare dir prefix like
/// `app/job/logic/` (treated as that dir and everything under it).
enum GlobMatch {
    static func matches(path: String, pattern rawPattern: String) -> Bool {
        let pattern = rawPattern.trimmingCharacters(in: .whitespaces)
        guard !pattern.isEmpty else { return true }
        // Bare dir/prefix (no glob metachars, or trailing slash) → prefix match.
        if !pattern.contains(where: { "*?[".contains($0) }) {
            let p = pattern.hasSuffix("/") ? pattern : pattern + "/"
            return path == pattern || path.hasPrefix(p) || path.hasPrefix(pattern + "/")
        }
        let regex = "^" + globToRegex(pattern) + "$"
        return path.range(of: regex, options: .regularExpression) != nil
    }
    /// Any of the comma-separated patterns matches (empty list → true).
    static func matchesAny(path: String, patterns rawList: String) -> Bool {
        let pats = rawList.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if pats.isEmpty { return true }
        return pats.contains { matches(path: path, pattern: $0) }
    }
    private static func globToRegex(_ glob: String) -> String {
        var r = ""
        var i = glob.startIndex
        while i < glob.endIndex {
            let c = glob[i]
            switch c {
            case "*":
                let next = glob.index(after: i)
                if next < glob.endIndex && glob[next] == "*" { r += ".*"; i = glob.index(after: next); continue }
                r += "[^/]*"
            case "?": r += "[^/]"
            case ".", "(", ")", "+", "|", "^", "$", "{", "}", "\\", "[", "]": r += "\\\(c)"
            default: r.append(c)
            }
            i = glob.index(after: i)
        }
        return r
    }
}
