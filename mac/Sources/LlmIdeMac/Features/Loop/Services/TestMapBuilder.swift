import Foundation

/// Builds a TestMap: every function from the code graph index, ranked untested-first.
struct TestMapBuilder {
    var gitRoot: URL
    var structure: TestStructure
    /// Directory whose `system/graph/graph.json` is read; defaults to `gitRoot`.
    /// The Loop passes the main checkout, since `system/` is gitignored and absent in a worktree.
    var graphRoot: URL? = nil

    private static let skipped: Set<String> = ["init", "deinit", "body", "main", "description"]
    private static let maxTestBytes = 2_000_000

    func build() throws -> TestMap {
        let tests = collectTests()
        var entries: [TestMapEntry] = []
        let source: String
        if let graph = GraphIndex.load(gitRoot: graphRoot ?? gitRoot) {
            source = "graph"
            for f in graph.files where TestSourceMapper.isSourceCandidate(f.path) {
                let stem = TestSourceMapper.sourceStem(forSourcePath: f.path)
                let name = ((f.path as NSString).lastPathComponent as NSString).deletingPathExtension
                // Callers: files that import this one, plus files whose calls resolve into it.
                let fanIn = Set(f.usedBy).union(graph.callerFiles(of: f.path)).count
                // Which tests are eligible for this file: computed once, not per function.
                let pool = testsFor(path: f.path, in: tests).filter { t in
                    (stem != nil && TestSourceMapper.sourceStem(forTestPath: t.path) == stem) || t.tokens.contains(name)
                }
                for fn in f.functions where !Self.skipped.contains(fn.name) && !fn.name.hasPrefix("_") {
                    let by = pool.filter { $0.tokens.contains(fn.name) }.map(\.path).sorted()
                    entries.append(TestMapEntry(path: f.path, function: fn.name, line: fn.line,
                                                fanIn: fanIn, loc: f.loc, testedBy: by))
                }
            }
        } else {
            source = "files"
            for (path, loc) in sourceFiles() {
                guard let stem = TestSourceMapper.sourceStem(forSourcePath: path) else { continue }
                let by = testsFor(path: path, in: tests)
                    .filter { TestSourceMapper.sourceStem(forTestPath: $0.path) == stem }.map(\.path).sorted()
                entries.append(TestMapEntry(path: path, function: "*", line: 1, fanIn: 0, loc: loc, testedBy: by))
            }
        }
        entries.sort { a, b in
            let ua = a.testedBy.isEmpty, ub = b.testedBy.isEmpty
            if ua != ub { return ua }
            if a.fanIn != b.fanIn { return a.fanIn > b.fanIn }
            if a.loc != b.loc { return a.loc > b.loc }
            if a.path != b.path { return a.path < b.path }
            if a.function != b.function { return a.function < b.function }
            return a.line < b.line
        }
        var testedFiles = Set<String>(), allFiles = Set<String>()
        for e in entries { allFiles.insert(e.path); if !e.testedBy.isEmpty { testedFiles.insert(e.path) } }
        let tested = entries.filter { !$0.testedBy.isEmpty }.count
        return TestMap(generatedAt: Date(), source: source, entries: entries,
                       untestedFunctions: entries.count - tested, testedFunctions: tested,
                       untestedFiles: allFiles.subtracting(testedFiles).count)
    }

    @discardableResult
    func write(_ map: TestMap, outputRoot: URL? = nil) throws -> URL {
        let out = outputRoot ?? gitRoot
        let json = out.appendingPathComponent(LoopOutputLayout.testMapJSON)
        let md = out.appendingPathComponent(LoopOutputLayout.testMapMD)
        try FileManager.default.createDirectory(at: json.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(map).write(to: json, options: .atomic)
        try map.render().write(to: md, atomically: true, encoding: .utf8)
        return md
    }

    // MARK: - helpers

    private struct TestFile { var path: String; var tokens: Set<String>; var rootIndex: Int }

    /// Identifier runs ([A-Za-z0-9_]) plus the contents of double-quoted string literals.
    static func tokenize(_ text: String) -> Set<String> {
        var out = Set<String>()
        var ident = [UInt8](), str = [UInt8](), inStr = false, escaped = false
        func isId(_ c: UInt8) -> Bool { (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 }
        func flush() { if !ident.isEmpty { out.insert(String(decoding: ident, as: UTF8.self)); ident.removeAll(keepingCapacity: true) } }
        for c in text.utf8 {
            if isId(c) { ident.append(c) } else { flush() }
            if inStr {
                if escaped { escaped = false; str.append(c) }
                else if c == 92 { escaped = true }
                else if c == 34 || c == 10 {
                    if !str.isEmpty { out.insert(String(decoding: str, as: UTF8.self)) }
                    str.removeAll(keepingCapacity: true); inStr = false
                } else { str.append(c) }
            } else if c == 34 { inStr = true }
        }
        flush()
        return out
    }

    private func collectTests() -> [TestFile] {
        var out: [TestFile] = []
        var seen = Set<String>()
        for (i, root) in structure.roots.enumerated() {
            let dir = root.testDir.isEmpty ? gitRoot : gitRoot.appendingPathComponent(root.testDir)
            guard let en = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey]) else { continue }
            for case let url as URL in en {
                let rel = relative(url)
                let comps = rel.split(separator: "/").map(String.init)
                if comps.contains(where: { TestSourceMapper.excludedDirs.contains($0) }) {
                    en.skipDescendants(); continue
                }
                guard TestSourceMapper.isTestPath(rel),
                      (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
                      (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0 <= Self.maxTestBytes,
                      seen.insert("\(i)|\(rel)").inserted,
                      let text = try? String(contentsOf: url, encoding: .utf8),
                      TestSourceMapper.containsTestMarker(text) else { continue }
                out.append(TestFile(path: rel, tokens: Self.tokenize(text), rootIndex: i))
            }
        }
        return out
    }

    /// Roots sharing the longest matching packageDir; prefer those listing the file's extension.
    private func testsFor(path: String, in tests: [TestFile]) -> [TestFile] {
        guard let best = structure.testRoot(forSourcePath: path) else { return [] }
        let ext = (path as NSString).pathExtension
        let same = structure.roots.enumerated().filter { $0.element.packageDir == best.packageDir }
        let byLang = same.filter { $0.element.languages.contains(ext) }
        let idx = Set((byLang.isEmpty ? same : byLang).map(\.offset))
        return tests.filter { idx.contains($0.rootIndex) }
    }

    private func sourceFiles() -> [(String, Int)] {
        var out: [(String, Int)] = []
        guard let en = FileManager.default.enumerator(at: gitRoot, includingPropertiesForKeys: [.isRegularFileKey]) else { return out }
        for case let url as URL in en {
            if TestSourceMapper.excludedDirs.contains(url.lastPathComponent) { en.skipDescendants(); continue }
            let rel = relative(url)
            guard TestSourceMapper.isSourceCandidate(rel),
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            out.append((rel, text.split(separator: "\n", omittingEmptySubsequences: false).count))
        }
        return out
    }

    private func relative(_ url: URL) -> String {
        let base = gitRoot.resolvingSymlinksInPath().path
        let p = url.resolvingSymlinksInPath().path
        return p.hasPrefix(base + "/") ? String(p.dropFirst(base.count + 1)) : p
    }
}
