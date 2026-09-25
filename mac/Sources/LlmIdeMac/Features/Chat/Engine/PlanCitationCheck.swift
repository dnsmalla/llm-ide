import Foundation

/// Markdown helpers the plan parsers share.
enum PlanMarkdown {
    /// `content` with every fenced code block's lines (``` or ~~~, fences
    /// included) emptied, line count kept — so what is shell or code in a plan
    /// is never read as a heading, a numbered step, a bullet or a path claim.
    static func blankingCodeFences(_ content: String) -> String {
        // The open fence's character and length. Per CommonMark a fence closes
        // only on a line of the SAME character, at least as long, with no info
        // string — so a "```bash" inside a "````markdown" block stays inside.
        var open: (char: Character, length: Int)?
        return content.components(separatedBy: "\n").map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let char = trimmed.first
            let run = trimmed.prefix(while: { $0 == char }).count
            if let fence = open {
                if char == fence.char, run >= fence.length, run == trimmed.count { open = nil }
                return ""
            }
            if let char, char == "`" || char == "~", run >= 3 {
                open = (char, run)
                return ""
            }
            return line
        }.joined(separator: "\n")
    }
}

/// The paths a plan cites that are not on disk, checked when the plan is
/// saved so the saved-plan card can say so before anyone presses Execute.
///
/// Borrowed in spirit from MiroFish's ReportAgent, whose sections may say only
/// what its tools returned: a plan is only as good as the files it names. The
/// knip plan that motivated this cited `package.json` line numbers and a
/// report that had already gone stale.
///
/// Deliberately conservative — a false alarm on every plan would teach the
/// user to ignore the line. Only inline code spans OUTSIDE code fences count,
/// only ones containing a `/`, and never a file the plan itself says it will
/// create (`Create:` / `Test:` lines, the writing-plans convention).
enum PlanCitationCheck {
    /// Missing paths in first-cited order, spelled as the plan spelled them
    /// (minus any `:12-34` line suffix). `root` is the project root; relative
    /// paths also resolve against any absolute folder the plan names (a
    /// `cd ~/code/app` line), because a chat rooted at a parent folder writes
    /// plans relative to the repo inside it.
    static func missingPaths(
        in plan: String,
        root: String?,
        home: String = NSHomeDirectory(),
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> [String] {
        let prose = PlanMarkdown.blankingCodeFences(plan)
        var created = Set<String>()
        var cited: [String] = []
        for line in prose.components(separatedBy: "\n") {
            let label = line.replacingOccurrences(of: "*", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: " \t-"))
                .lowercased()
            if label.hasPrefix("create:") || label.hasPrefix("test:") {
                created.formUnion(codeSpans(in: line).compactMap { normalizedPath($0, fileLine: true) })
                continue
            }
            // Per sentence, not per line: "`a/old.ts` was deleted. `a/new.ts`
            // is used by the build." reports the first and claims the second.
            // "Modify: `apps/web`" asserts a path exists even without an
            // extension; elsewhere such a span may be a branch or a slug.
            let fileLine = fileLineLabels.contains { label.hasPrefix($0) }
            for sentence in sentences(in: line) {
                // "`apps/shared/validation/` … none of which still exist" —
                // the plan is REPORTING that it is missing, correctly.
                guard !saysGone(sentence.lowercased()) else { continue }
                cited.append(contentsOf: codeSpans(in: sentence).compactMap { normalizedPath($0, fileLine: fileLine) })
            }
        }

        let bases = ([root].compactMap { $0 } + namedFolders(in: plan, home: home))
            .map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 }
        var seen = Set<String>()
        return cited.filter { path in
            guard !created.contains(path), seen.insert(path).inserted else { return false }
            // `types/api.ts` beside a cited `apps/shared/types/api.ts`: the
            // short spelling is package-relative, and the plan knows the full
            // path, which is what gets checked.
            if !path.hasPrefix("/"), !path.hasPrefix("~"),
               cited.contains(where: { $0 != path && $0.hasSuffix("/" + path) }) { return false }
            return !exists(path, bases: bases, home: home, fileExists: fileExists)
        }
    }

    /// A line split after `.`, `!` or `?` followed by a space — but never
    /// inside a code span, where `e.g. x` or a path's dots must not split it.
    private static func sentences(in line: String) -> [String] {
        var out: [String] = []
        var current = ""
        var inCode = false
        var previous: Character?
        for char in line {
            if char == "`" { inCode.toggle() }
            if !inCode, char == " ", let p = previous, ".!?".contains(p) {
                out.append(current)
                current = ""
            } else {
                current.append(char)
            }
            previous = char
        }
        out.append(current)
        return out
    }

    private static let goneRegex = try! NSRegularExpression(
        pattern: #"\b(no longer exists?|(does|do|did) not exist|doesn't exist|don't exist|still exists?|not exist|"#
            + #"was deleted|were deleted|was removed|were removed|already gone|is gone|are gone|is stale)\b"#)

    /// A line that says what it names is gone ("none of which still exist",
    /// "was deleted"). "still exist" counts because it only ever appears in
    /// that position negated ("none of which still exist").
    private static func saysGone(_ line: String) -> Bool {
        goneRegex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
    }

    // MARK: - Private

    private static func exists(_ path: String, bases: [String], home: String,
                               fileExists: (String) -> Bool) -> Bool {
        if path.hasPrefix("/") { return fileExists(path) }
        if path.hasPrefix("~/") { return fileExists(home + path.dropFirst()) }
        return bases.contains { fileExists("\($0)/\(path)") }
    }

    private static func codeSpans(in line: String) -> [String] {
        let parts = line.components(separatedBy: "`")
        // Odd indices are inside backticks; an unclosed trailing span is not.
        return stride(from: 1, to: parts.count - 1, by: 2).map { parts[$0] }
    }

    /// Folders only ignored as scratch or system space.
    private static let ignoredPrefixes = ["/tmp/", "/private/tmp/", "/var/folders/", "/dev/"]
    private static let pathShape = try! NSRegularExpression(pattern: #"^[~\p{L}\p{N}._/+-]+$"#)

    /// The span as a path claim, or nil when it is a command, URL, glob,
    /// placeholder, package spec, bare file name or scratch path.
    /// Lines whose spans are path claims by construction (writing-plans'
    /// **Files:** list).
    private static let fileLineLabels = ["modify:", "delete:", "remove:", "move:", "rename:", "edit:", "update:"]

    /// The span as a path claim, or nil when it is a command, URL, glob,
    /// placeholder, package spec, bare file name or scratch path — or a
    /// slash-bearing word that is not a path at all: a branch
    /// (`fix/chat-token-overhead`), a remote ref (`origin/main`), a repo
    /// slug (`dnsmalla/graph-kit`), a MIME type (`text/plain`). Those look
    /// like relative paths, so outside a Files line a span must also LOOK
    /// like a file: an extension, a trailing `/`, or a dot-folder.
    private static func normalizedPath(_ span: String, fileLine: Bool) -> String? {
        var s = span.trimmingCharacters(in: .whitespaces)
        while let last = s.last, ".,;:)".contains(last) { s.removeLast() }
        if let range = s.range(of: #":\d+(-\d+)?$"#, options: .regularExpression) {
            s.removeSubrange(range)
        }
        if s.hasPrefix("./") { s.removeFirst(2) }
        let namedAsFolder = s.count > 1 && s.hasSuffix("/")
        while s.count > 1, s.hasSuffix("/") { s.removeLast() }
        guard s.contains("/"), !s.contains("://"), !s.hasPrefix("-"),
              !s.contains("node_modules"),
              !ignoredPrefixes.contains(where: { s.hasPrefix($0) || s + "/" == $0 }),
              pathShape.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
        else { return nil }
        let components = s.split(separator: "/")
        let ext = (s as NSString).pathExtension
        let looksLikeFile = s.hasPrefix("/") || s.hasPrefix("~/") || namedAsFolder
            || (ext.contains(where: \.isLetter) && ext.count <= 10)
            || components.contains { $0.hasPrefix(".") && $0 != "." && $0 != ".." }
        return (fileLine || looksLikeFile) ? s : nil
    }

    private static let absolutePathRegex = try! NSRegularExpression(
        pattern: #"(?:^|[\s`"'(=])((?:~|/)[\p{L}\p{N}._/+-]+)"#, options: [.anchorsMatchLines])

    /// Absolute folders mentioned anywhere in the plan, fences included (a
    /// `cd` line is usually in a bash block): each one as written, plus the
    /// folder of anything that looks like a file.
    private static func namedFolders(in plan: String, home: String) -> [String] {
        var folders: [String] = []
        let range = NSRange(plan.startIndex..., in: plan)
        for match in absolutePathRegex.matches(in: plan, range: range) {
            guard let r = Range(match.range(at: 1), in: plan) else { continue }
            var path = String(plan[r])
            while let last = path.last, ".,;:)".contains(last) { path.removeLast() }
            if path.hasPrefix("~/") { path = home + path.dropFirst() }
            guard path.count > 1, !ignoredPrefixes.contains(where: { path.hasPrefix($0) }) else { continue }
            let folder = (path as NSString).pathExtension.isEmpty ? path : (path as NSString).deletingLastPathComponent
            if !folders.contains(folder) { folders.append(folder) }
            if folders.count >= 20 { break }
        }
        return folders
    }
}
