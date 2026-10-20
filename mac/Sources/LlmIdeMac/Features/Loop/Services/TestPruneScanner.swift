import Foundation

/// Report-only scan for tests the guideline says to delete. It reads files and
/// writes one report; it never touches a test file.
public struct TestPruneScanner {
    var gitRoot: URL
    var structure: TestStructure

    public init(gitRoot: URL, structure: TestStructure) {
        self.gitRoot = gitRoot; self.structure = structure
    }

    private static let assertionTokens = ["assert", "XCTAssert", "#expect", "expect(", "pytest.raises",
                                          "t.Error", "t.Fatal", "#require"]
    private static let maxBytes = 2_000_000
    // integration/ and performance/ tests do not mirror a source file.
    private static let unmirroredDirs: Set<String> = ["integration", "performance"]
    private static let commentedTest: NSRegularExpression? = try? NSRegularExpression(
        pattern: #"^\s*(#|//)\s*(def test_|func test|it\(\s*['"]|test\(\s*['"])"#)

    public func scan() -> [TestPruneFinding] {
        let files = allFiles()
        let fileSet = Set(files)
        var findings: [TestPruneFinding] = []
        var seen = Set<String>()
        for root in structure.roots {
            let pkg = root.packageDir
            let inPackage: (String) -> Bool = { pkg.isEmpty || $0.hasPrefix(pkg + "/") }
            let testBase = root.testDir
            let inTests: (String) -> Bool = { path in
                testBase.isEmpty ? inPackage(path) : (path == testBase || path.hasPrefix(testBase + "/"))
            }
            let stems = Set(files.filter { inPackage($0) && TestSourceMapper.isSourceCandidate($0) }
                .compactMap { TestSourceMapper.sourceStem(forSourcePath: $0) })
            for rel in files where inTests(rel) && TestSourceMapper.isTestPath(rel) && seen.insert(rel).inserted {
                findings += scanFile(rel, stems: stems, fileSet: fileSet)
            }
        }
        return findings.sorted { ($0.path, $0.reason.rawValue, $0.line ?? 0) < ($1.path, $1.reason.rawValue, $1.line ?? 0) }
    }

    @discardableResult
    public func write(_ findings: [TestPruneFinding], outputRoot: URL) throws -> URL {
        let md = outputRoot.appendingPathComponent(LoopOutputLayout.testPruneMD)
        try FileManager.default.createDirectory(at: md.deletingLastPathComponent(), withIntermediateDirectories: true)
        try TestPruneReport.render(findings).write(to: md, atomically: true, encoding: .utf8)
        return md
    }

    // MARK: - helpers

    private func scanFile(_ rel: String, stems: Set<String>, fileSet: Set<String>) -> [TestPruneFinding] {
        var out: [TestPruneFinding] = []
        let url = gitRoot.appendingPathComponent(rel)
        guard (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0 <= Self.maxBytes,
              let text = try? String(contentsOf: url, encoding: .utf8),
              // Helper files carry no tests, so none of the findings apply to them.
              TestSourceMapper.containsTestMarker(text) else { return out }
        let dirs = rel.split(separator: "/").dropLast().map(String.init)
        if !dirs.contains(where: { Self.unmirroredDirs.contains($0) }),
           let stem = TestSourceMapper.sourceStem(forTestPath: rel), !stems.contains(stem) {
            out.append(TestPruneFinding(path: rel, reason: .sourceGone))
        }
        if let sibling = nonGapSibling(of: rel), fileSet.contains(sibling) {
            out.append(TestPruneFinding(path: rel, reason: .gapDuplicate))
        }
        if !Self.assertionTokens.contains(where: text.contains) {
            out.append(TestPruneFinding(path: rel, reason: .noAssertion))
        }
        if let rx = Self.commentedTest {
            for (index, line) in text.components(separatedBy: "\n").enumerated() {
                let range = NSRange(line.startIndex..., in: line)
                if rx.firstMatch(in: line, range: range) != nil {
                    out.append(TestPruneFinding(path: rel, reason: .commentedOutTest, line: index + 1))
                }
            }
        }
        return out
    }

    /// The regular test file a gap-writer file duplicates, or nil when `rel` is not a gap file.
    private func nonGapSibling(of rel: String) -> String? {
        let dir = (rel as NSString).deletingLastPathComponent
        let file = (rel as NSString).lastPathComponent
        let ext = (file as NSString).pathExtension
        let name = (file as NSString).deletingPathExtension
        let sibling: String
        switch ext {
        case "swift":
            guard name.hasSuffix("GapTests"), name.count > 8 else { return nil }
            sibling = String(name.dropLast(8)) + "Tests.swift"
        case "py":
            guard name.hasPrefix("test_"), name.hasSuffix("_gap"), name.count > 9 else { return nil }
            sibling = String(name.dropLast(4)) + ".py"
        case "mjs", "cjs", "js", "jsx", "ts", "tsx":
            guard name.hasSuffix(".gap.test") || name.hasSuffix(".gap.spec"), name.count > 9 else { return nil }
            sibling = String(name.dropLast(9)) + String(name.suffix(5)) + "." + ext
        default: return nil
        }
        return dir.isEmpty ? sibling : dir + "/" + sibling
    }

    private func allFiles() -> [String] {
        var out: [String] = []
        guard let en = FileManager.default.enumerator(at: gitRoot, includingPropertiesForKeys: [.isRegularFileKey]) else { return out }
        let base = gitRoot.resolvingSymlinksInPath().path
        for case let url as URL in en {
            let name = url.lastPathComponent
            // Build products (.build, .build-lite, ...) are ~1 GB each and never hold sources or tests.
            if TestSourceMapper.excludedDirs.contains(name) || name.hasPrefix(".build") {
                en.skipDescendants(); continue
            }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let path = url.resolvingSymlinksInPath().path
            out.append(path.hasPrefix(base + "/") ? String(path.dropFirst(base.count + 1)) : path)
        }
        return out
    }
}
