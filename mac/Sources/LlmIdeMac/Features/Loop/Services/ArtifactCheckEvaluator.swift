import Foundation

/// Evaluates an `ArtifactCheckSpec` against the working tree. Pure file IO, no
/// shell and no agent: `LoopEngineRunner` calls it off the main actor.
enum ArtifactCheckEvaluator {
    struct Result: Equatable {
        var failures: [String]
        var passed: Bool { failures.isEmpty }

        /// Failure text for the log, the journal and the repair feedback.
        var message: String {
            let shown = failures.prefix(Self.maxListed)
            let more = failures.count > shown.count ? "\n… and \(failures.count - shown.count) more" : ""
            return shown.joined(separator: "\n") + more
        }
        static let maxListed = 20
    }

    /// `roots.repo` is the run's working tree (a worktree when the run was
    /// redirected into one); `roots.project` the project root, used only for
    /// specs with `projectRootFallback`.
    struct Roots {
        var repo: URL
        var project: URL?
    }

    /// Directories never walked when expanding a glob.
    private static let skippedDirs: Set<String> = [".git", "node_modules", ".build", ".swiftpm", "DerivedData"]

    /// Line counts memoised for ONE evaluation (a file is often named by both a
    /// line limit and a citation).
    private final class LineCounter {
        private var cache: [String: Int] = [:]
        func count(_ url: URL) -> Int {
            if let hit = cache[url.path] { return hit }
            let n = ArtifactCheckEvaluator.lineCount(url)
            cache[url.path] = n
            return n
        }
    }

    /// `stages` are the loop's ENABLED stages; the spec's output rules follow
    /// their current Outputs (see `ArtifactCheckSpec.resolved`).
    nonisolated static func evaluate(_ rawSpec: ArtifactCheckSpec, roots: Roots,
                                     stages: [LoopStage] = []) -> Result {
        let spec = rawSpec.resolved(against: stages)
        let lines = LineCounter()
        var failures: [String] = []
        let fm = FileManager.default

        func resolve(_ relative: String) -> URL? {
            var candidates = [roots.repo.appendingPathComponent(relative)]
            // Same rule as LoopStagePaths: when the file's parent folder exists
            // in the repo, that is where the stage wrote — a stale copy under
            // the project root must not satisfy the check.
            let parent = (relative as NSString).deletingLastPathComponent
            let repoHasParent = !parent.isEmpty
                && fm.fileExists(atPath: roots.repo.appendingPathComponent(parent).path)
            if spec.projectRootFallback, !repoHasParent, let project = roots.project {
                candidates.append(project.appendingPathComponent(relative))
            }
            return candidates.first { fm.fileExists(atPath: $0.path) }
        }

        for path in spec.requiredPaths where resolve(path) == nil {
            failures.append("missing: \(path)")
        }

        for limit in spec.lineLimits {
            var files: [(rel: String, url: URL)] = []
            for base in [roots.repo] + (spec.projectRootFallback ? [roots.project].compactMap { $0 } : []) {
                for rel in expand(glob: limit.glob, under: base) where !files.contains(where: { $0.rel == rel }) {
                    files.append((rel, base.appendingPathComponent(rel)))
                }
            }
            for file in files where !limit.excludes.contains(where: { GlobMatch.matches(path: file.rel, pattern: $0) }) {
                let count = lines.count(file.url)
                if count > limit.maxLines {
                    failures.append("\(file.rel): \(count) lines (limit \(limit.maxLines))")
                }
            }
        }

        if !spec.citationGlobs.isEmpty {
            var seen = Set<String>()
            for glob in spec.citationGlobs {
                for base in [roots.repo] + (spec.projectRootFallback ? [roots.project].compactMap { $0 } : []) {
                    for rel in expand(glob: glob, under: base) where rel.hasSuffix(".md") {
                        let url = base.appendingPathComponent(rel)
                        guard seen.insert(url.path).inserted,
                              let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
                        for bad in unresolvedCitations(in: text, repo: roots.repo, lineCount: lines.count) {
                            failures.append("\(rel): citation does not resolve: `\(bad)`")
                        }
                    }
                }
            }
        }
        if !spec.sectionRules.isEmpty {
            var seen = Set<String>()
            for glob in spec.sectionTargets {
                for base in [roots.repo] + (spec.projectRootFallback ? [roots.project].compactMap { $0 } : []) {
                    for rel in expand(glob: glob, under: base) {
                        let url = base.appendingPathComponent(rel)
                        guard seen.insert(url.path).inserted,
                              let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
                        failures += sectionFailures(in: text, rules: spec.sectionRules)
                    }
                }
            }
        }
        return Result(failures: failures)
    }

    /// One failure per (section, missing prefix). A section starts at a line
    /// beginning with `headerPrefix` and runs up to the next `### ` line; a
    /// required prefix counts only when it starts some line in that section.
    nonisolated static func sectionFailures(in text: String,
                                            rules: [ArtifactCheckSpec.SectionRule]) -> [String] {
        let all = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var out: [String] = []
        for rule in rules {
            var i = 0
            while i < all.count {
                let header = all[i]
                guard header.hasPrefix(rule.headerPrefix) else { i += 1; continue }
                var end = i + 1
                while end < all.count, !all[end].hasPrefix("### ") { end += 1 }
                let body = all[(i + 1)..<end]
                for prefix in rule.requiredLinePrefixes where !body.contains(where: { $0.hasPrefix(prefix) }) {
                    out.append("\(header): missing `\(prefix)`")
                }
                i = end
            }
        }
        return out
    }

    /// Backticked repo paths / `path:line` citations in `markdown` that do not
    /// resolve under `repo`. A bare symbol name is not a path citation and is
    /// ignored; so is anything that is clearly not a repo path (URL, absolute,
    /// home-relative, template, glob).
    nonisolated static func unresolvedCitations(in markdown: String, repo: URL,
                                                lineCount: ((URL) -> Int)? = nil) -> [String] {
        let countLines = lineCount ?? { ArtifactCheckEvaluator.lineCount($0) }
        let fm = FileManager.default
        var bad: [String] = []
        var seen = Set<String>()
        var inFence = false
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { inFence.toggle(); continue }
            if inFence { continue }
            for token in backticked(String(line)) {
                guard let (path, lineNo) = pathCitation(token, repo: repo), seen.insert(token).inserted else { continue }
                let url = repo.appendingPathComponent(path)
                var isDir: ObjCBool = false
                let exists = fm.fileExists(atPath: url.path, isDirectory: &isDir)
                if !exists { bad.append(token); continue }
                // `path:line` on a directory is not a line citation.
                if let lineNo, !isDir.boolValue, countLines(url) < lineNo { bad.append(token) }
            }
        }
        return bad
    }

    private nonisolated static func backticked(_ line: String) -> [String] {
        var out: [String] = []
        var current: String?
        for ch in line {
            if ch == "`" {
                if let c = current { if !c.isEmpty { out.append(c) }; current = nil } else { current = "" }
            } else if current != nil {
                current!.append(ch)
            }
        }
        return out
    }

    /// `(path, line?)` when `token` is a path citation: its FIRST path segment
    /// exists under `repo` (or, for a bare name, the file exists at the root).
    /// That rule is what keeps branch names (`origin/main`), MIME types
    /// (`application/json`) and npm scopes (`@anthropic-ai/sdk`) from being
    /// mistaken for repo paths, while a path into a real top-level directory
    /// that is missing further down is still caught.
    private nonisolated static func pathCitation(_ token: String, repo: URL) -> (String, Int?)? {
        var body = token.trimmingCharacters(in: .whitespaces)
        guard !body.isEmpty, !body.contains(where: { " *<>{}$()|\\\"'".contains($0) }),
              !body.hasPrefix("/"), !body.hasPrefix("~"), !body.contains("://") else { return nil }
        var line: Int?
        if let colon = body.lastIndex(of: ":") {
            let tail = body[body.index(after: colon)...]
            // `path:12` or `path:12-20` — only the start line is checked.
            let head = tail.split(separator: "-").first.map(String.init) ?? ""
            guard let n = Int(head), !head.isEmpty else { return nil }
            line = n
            body = String(body[..<colon])
        }
        if body.hasPrefix("./") { body.removeFirst(2) }
        guard !body.isEmpty, !body.contains(".."),
              body.allSatisfy({ $0.isLetter || $0.isNumber || "._-/@+".contains($0) }) else { return nil }
        let first = body.split(separator: "/", omittingEmptySubsequences: true).first.map(String.init) ?? body
        guard FileManager.default.fileExists(atPath: repo.appendingPathComponent(first).path) else { return nil }
        return (body, line)
    }

    fileprivate nonisolated static func lineCount(_ url: URL) -> Int {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return 0 }
        var n = data.reduce(0) { $1 == 0x0A ? $0 + 1 : $0 }
        if data.last != 0x0A { n += 1 }
        return n
    }

    /// Repo-relative files under `base` matching `glob`, walking only the
    /// glob's literal directory prefix.
    private nonisolated static func expand(glob rawGlob: String, under base: URL) -> [String] {
        let glob = rawGlob.trimmingCharacters(in: .whitespaces)
        guard !glob.isEmpty else { return [] }
        var prefixParts: [String] = []
        for part in glob.split(separator: "/", omittingEmptySubsequences: true) {
            if part.contains(where: { "*?[".contains($0) }) { break }
            prefixParts.append(String(part))
        }
        let fm = FileManager.default
        var start = base
        var prefixPath = prefixParts.joined(separator: "/")
        var isDir: ObjCBool = false
        // A fully literal glob naming a file is just that file.
        if !glob.contains(where: { "*?[".contains($0) }) {
            let url = base.appendingPathComponent(glob)
            if fm.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue { return [glob] }
        } else if !prefixParts.isEmpty {
            start = base.appendingPathComponent(prefixPath)
        }
        if !glob.contains(where: { "*?[".contains($0) }) {
            start = base.appendingPathComponent(glob)
            prefixPath = glob
        }
        guard fm.fileExists(atPath: start.path, isDirectory: &isDir), isDir.boolValue,
              let walker = fm.enumerator(atPath: start.path) else { return [] }
        var out: [String] = []
        // `enumerator(atPath:)` yields paths relative to `start`, so there is
        // no symlink-resolved prefix (/var vs /private/var) to strip.
        for case let sub as String in walker {
            let isDirectory = (walker.fileAttributes?[.type] as? FileAttributeType) == .typeDirectory
            if isDirectory {
                if skippedDirs.contains((sub as NSString).lastPathComponent) { walker.skipDescendants() }
                continue
            }
            let rel = (prefixPath.isEmpty ? "" : prefixPath + "/") + sub
            if GlobMatch.matches(path: rel, pattern: glob) { out.append(rel) }
        }
        return out.sorted()
    }
}
