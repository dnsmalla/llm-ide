import Foundation

/// One parsed `.gitignore` pattern.
///
/// `base` is the repo-relative directory whose `.gitignore` produced this rule
/// ("" for the repo root). A rule only ever applies to paths under its own
/// base — that is what scopes a nested `.gitignore` to its own subtree.
struct GitIgnoreRule {
    let base: String
    /// Anchored `^…$` over the path RELATIVE TO `base`.
    let regex: NSRegularExpression
    /// `!pattern` — a match UN-ignores instead of ignoring.
    let isNegated: Bool
    /// `pattern/` — only matches a directory.
    let dirOnly: Bool

    /// Does this rule match `path` (repo-relative, no leading slash)?
    /// `isDirectory` describes `path` itself.
    func matches(path: String, isDirectory: Bool) -> Bool {
        if dirOnly && !isDirectory { return false }
        let sub: String
        if base.isEmpty {
            sub = path
        } else if path.hasPrefix(base + "/") {
            sub = String(path.dropFirst(base.count + 1))
        } else {
            return false
        }
        let ns = sub as NSString
        return regex.firstMatch(in: sub, options: [],
                                range: NSRange(location: 0, length: ns.length)) != nil
    }
}

/// A `.gitignore` evaluator, parsed in Swift rather than shelled out to
/// `git check-ignore`.
///
/// Why in-process: `check-ignore` costs one subprocess per candidate path (or
/// a long-lived pipe to babysit), and it FAILS OUTRIGHT in a folder that is
/// not a git repo — which Search must still handle, since `WorkspaceRoot` can
/// resolve to a plain project folder. Parsing here is pure, testable, and runs
/// inside the same off-main walk that already reads the files.
///
/// SUPPORTED: `#` comments, blank lines, trailing-whitespace trimming, `!`
/// negation, trailing `/` (directory-only), leading `/` or an embedded `/`
/// (anchored to the rule's own directory), `*`, `?`, `**/`, `/**`, and nested
/// `.gitignore` files.
///
/// NOT SUPPORTED, deliberately: character classes (`[a-z]`) and backslash
/// escapes. A pattern containing `[`, `]` or `\` degrades to a LITERAL match
/// (every metacharacter regex-escaped) rather than silently meaning something
/// else. `core.excludesFile` (the user's global ignore) is not consulted.
struct GitIgnoreRules {
    private(set) var rules: [GitIgnoreRule] = []

    var isEmpty: Bool { rules.isEmpty }

    /// Root rules: `<root>/.gitignore` then `<root>/.git/info/exclude`.
    /// Missing files are skipped, so a non-repo folder yields an empty
    /// (always-false) evaluator instead of an error.
    static func repoRoot(_ root: URL) -> GitIgnoreRules {
        var out = GitIgnoreRules()
        out.addFile(at: root.appendingPathComponent(".gitignore"), base: "")
        out.addFile(at: root.appendingPathComponent(".git/info/exclude"), base: "")
        return out
    }

    /// Append the rules in `url`, scoped to `base`. No-op when unreadable.
    mutating func addFile(at url: URL, base: String) {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else { return }
        add(text: text, base: base)
    }

    /// Append parsed rules. ORDER MATTERS: later rules win, so a nested
    /// `.gitignore` must be added AFTER the rules it may override — which a
    /// pre-order directory walk gives for free.
    mutating func add(text: String, base: String) {
        rules.append(contentsOf: Self.parse(text, base: base))
    }

    /// Is `relativePath` (repo-relative, no leading slash) ignored?
    ///
    /// Every ancestor directory is tested first and short-circuits: git cannot
    /// re-include a file whose parent directory is excluded, so the first
    /// ancestor that comes out ignored is final.
    func isIgnored(relativePath: String, isDirectory: Bool) -> Bool {
        let comps = relativePath.split(separator: "/").map(String.init)
        guard !comps.isEmpty else { return false }
        for i in comps.indices {
            let prefix = comps[0...i].joined(separator: "/")
            let prefixIsDir = (i < comps.count - 1) || isDirectory
            if decide(path: prefix, isDirectory: prefixIsDir) { return true }
        }
        return false
    }

    /// Last matching rule wins — git's own precedence within one path level.
    private func decide(path: String, isDirectory: Bool) -> Bool {
        var ignored = false
        for rule in rules where rule.matches(path: path, isDirectory: isDirectory) {
            ignored = !rule.isNegated
        }
        return ignored
    }

    static func parse(_ text: String, base: String) -> [GitIgnoreRule] {
        var out: [GitIgnoreRule] = []
        for rawLine in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            var line = String(rawLine)
            // Trailing whitespace is insignificant. (Escaping it is a
            // backslash form, which this parser deliberately does not support.)
            while line.hasSuffix(" ") || line.hasSuffix("\t") { line.removeLast() }
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            var isNegated = false
            if line.hasPrefix("!") { isNegated = true; line.removeFirst() }
            var dirOnly = false
            if line.hasSuffix("/") { dirOnly = true; line.removeLast() }
            guard !line.isEmpty else { continue }
            // Computed BEFORE the leading slash is stripped: a slash anywhere
            // in the pattern anchors it to the .gitignore's own directory,
            // while a bare name matches at any depth below it.
            let anchored = line.contains("/")
            if line.hasPrefix("/") { line.removeFirst() }
            guard !line.isEmpty else { continue }
            let pattern = "^" + (anchored ? "" : "(?:.*/)?") + translate(line) + "$"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            out.append(GitIgnoreRule(base: base, regex: regex,
                                     isNegated: isNegated, dirOnly: dirOnly))
        }
        return out
    }

    /// Glob body → regex body (no anchors — `parse` adds those).
    static func translate(_ glob: String) -> String {
        // Ruling: character classes and backslash escapes are out of scope.
        // Degrade to a literal match instead of producing a wrong regex.
        if glob.contains("[") || glob.contains("]") || glob.contains("\\") {
            return NSRegularExpression.escapedPattern(for: glob)
        }
        var out = ""
        var i = glob.startIndex
        while i < glob.endIndex {
            let c = glob[i]
            if c == "*" {
                let next = glob.index(after: i)
                if next < glob.endIndex, glob[next] == "*" {
                    let after = glob.index(after: next)
                    if after < glob.endIndex, glob[after] == "/" {
                        out += "(?:.*/)?"          // `**/` — zero or more dirs
                        i = glob.index(after: after)
                        continue
                    }
                    out += ".*"                     // `/**` or a bare `**`
                    i = after
                    continue
                }
                out += "[^/]*"
            } else if c == "?" {
                out += "[^/]"
            } else {
                out += NSRegularExpression.escapedPattern(for: String(c))
            }
            i = glob.index(after: i)
        }
        return out
    }
}
