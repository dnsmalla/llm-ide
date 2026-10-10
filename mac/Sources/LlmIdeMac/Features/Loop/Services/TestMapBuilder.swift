import Foundation

/// Builds a TestMap: every function from the code graph index, ranked untested-first.
struct TestMapBuilder {
    var gitRoot: URL
    var structure: TestStructure

    private static let skipped: Set<String> = ["init", "deinit", "body", "main", "description"]
    private static let maxTestBytes = 2_000_000

    func build() throws -> TestMap {
        let tests = collectTests()
        var entries: [TestMapEntry] = []
        let source: String
        if let graph = GraphIndex.load(gitRoot: gitRoot) {
            source = "graph"
            for f in graph.files where TestSourceMapper.isSourceCandidate(f.path) {
                let stem = TestSourceMapper.sourceStem(forSourcePath: f.path)
                let base = (f.path as NSString).lastPathComponent
                let name = (base as NSString).deletingPathExtension
                let pool = testsFor(path: f.path, in: tests)
                for fn in f.functions where !Self.skipped.contains(fn.name) && !fn.name.hasPrefix("_") {
                    let by = pool.filter { t in
                        let hit = t.text.contains("\(fn.name)(") || t.text.contains(".\(fn.name)(") || t.text.contains("\"\(fn.name)\"")
                        guard hit else { return false }
                        return (stem != nil && TestSourceMapper.sourceStem(forTestPath: t.path) == stem) || t.text.contains(name)
                    }.map(\.path).sorted()
                    entries.append(TestMapEntry(path: f.path, function: fn.name, line: fn.line,
                                                fanIn: f.usedBy.count, loc: f.loc, testedBy: by))
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
            return a.function < b.function
        }
        var testedFiles = Set<String>(), allFiles = Set<String>()
        for e in entries { allFiles.insert(e.path); if !e.testedBy.isEmpty { testedFiles.insert(e.path) } }
        let tested = entries.filter { !$0.testedBy.isEmpty }.count
        return TestMap(generatedAt: Date(), source: source, entries: entries,
                       untestedFunctions: entries.count - tested, testedFunctions: tested,
                       untestedFiles: allFiles.subtracting(testedFiles).count)
    }

    @discardableResult
    func write(_ map: TestMap) throws -> URL {
        let json = gitRoot.appendingPathComponent(LoopOutputLayout.testMapJSON)
        let md = gitRoot.appendingPathComponent(LoopOutputLayout.testMapMD)
        try FileManager.default.createDirectory(at: json.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(map).write(to: json, options: .atomic)
        try map.render().write(to: md, atomically: true, encoding: .utf8)
        return md
    }

    // MARK: - helpers

    private struct TestFile { var path: String; var text: String; var rootIndex: Int }

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
                out.append(TestFile(path: rel, text: text, rootIndex: i))
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
