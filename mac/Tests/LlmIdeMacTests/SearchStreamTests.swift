import XCTest
@testable import LlmIdeMacLib

/// The streaming search end-to-end, against a REAL temp tree — the candidate
/// walk's whole job is deciding what the filesystem contains, so mocking the
/// filesystem would test nothing.
final class SearchStreamTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("search-stream-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func write(_ relativePath: String, _ contents: String) {
        let url = root.appendingPathComponent(relativePath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? contents.write(to: url, atomically: true, encoding: .utf8)
    }

    private func paths(include: String = "",
                       exclude: String = "",
                       respectGitignore: Bool = true) -> [String] {
        SearchEngine.collectCandidates(root: root, include: include, exclude: exclude,
                                       respectGitignore: respectGitignore,
                                       isCancelled: { false }).map(\.displayPath)
    }

    private func regex(_ query: String) -> NSRegularExpression {
        // Force-unwrap is fine in a test: an unbuildable pattern is a test bug.
        SearchService.makeRegex(query: query, options: SearchOptions())!
    }

    // MARK: - collectCandidates

    func testCollectsPlainFilesSortedByDisplayPath() {
        write("z.txt", "z")
        write("a.txt", "a")
        write("m/b.txt", "b")
        XCTAssertEqual(paths(), ["a.txt", "m/b.txt", "z.txt"])
    }

    /// Non-ASCII and spaced paths are first-class here: this app's users work
    /// in Japanese, and two P2 bugs came from a path assumed to be ASCII.
    func testHandlesNonASCIIAndSpacedPaths() {
        write("設計.txt", "x")
        write("my docs/メモ 1.txt", "x")
        XCTAssertEqual(paths(), ["my docs/メモ 1.txt", "設計.txt"])
    }

    func testRootGitignoreExcludesMatchingFiles() {
        write(".gitignore", "*.log\n")
        write("keep.txt", "x")
        write("drop.log", "x")
        XCTAssertEqual(paths(), ["keep.txt"])
    }

    func testGitignoredDirectoryIsSkippedWhole() {
        write(".gitignore", "generated/\n")
        write("generated/a.txt", "x")
        write("generated/deep/b.txt", "x")
        write("keep.txt", "x")
        XCTAssertEqual(paths(), ["keep.txt"])
    }

    func testNestedGitignoreAppliesOnlyToItsSubtree() {
        write("sub/.gitignore", "*.tmp\n")
        write("sub/a.tmp", "x")
        write("sub/a.txt", "x")
        write("a.tmp", "x")
        XCTAssertEqual(paths(), ["a.tmp", "sub/a.txt"])
    }

    /// `respectGitignore: false` drops the whole ignore layer — the noise-dir
    /// and glob filters still apply.
    func testGitignoreCanBeTurnedOff() {
        write(".gitignore", "*.log\n")
        write("keep.txt", "x")
        write("drop.log", "x")
        XCTAssertEqual(paths(respectGitignore: false), ["drop.log", "keep.txt"])
    }

    func testNoiseDirectoriesAreSkippedWithoutAGitignore() {
        write("node_modules/dep/index.js", "x")
        write("app.js", "x")
        XCTAssertEqual(paths(), ["app.js"])
    }

    func testIncludeGlobFilters() {
        write("a.swift", "x")
        write("b.txt", "x")
        XCTAssertEqual(paths(include: "*.swift"), ["a.swift"])
    }

    func testExcludeGlobFilters() {
        write("a.swift", "x")
        write("b.txt", "x")
        XCTAssertEqual(paths(exclude: "*.txt"), ["a.swift"])
    }

    func testCollectStopsEarlyWhenCancelled() {
        for i in 0..<40 { write("f\(i).txt", "x") }
        let collected = SearchEngine.collectCandidates(
            root: root, include: "", exclude: "", isCancelled: { true })
        XCTAssertTrue(collected.isEmpty)
    }

    // MARK: - stream

    func testStreamYieldsFilesThenFinished() async {
        write("a.txt", "needle\n")
        write("b.txt", "nothing\n")
        write("c.txt", "x\nneedle\nneedle\n")

        var files: [String] = []
        var finished: (Int, Int)?
        for await event in SearchService.stream(regex: regex("needle"), root: root,
                                                include: "", exclude: "") {
            switch event {
            case .file(let fm):           files.append(fm.displayPath)
            case .truncated:              XCTFail("three matches must not hit the cap")
            case .finished(let t, let f): finished = (t, f)
            }
        }
        XCTAssertEqual(files, ["a.txt", "c.txt"])
        XCTAssertEqual(finished?.0, 3)
        XCTAssertEqual(finished?.1, 2)
    }

    func testStreamRespectsGitignore() async {
        write(".gitignore", "ignored/\n")
        write("ignored/a.txt", "needle\n")
        write("kept.txt", "needle\n")

        var files: [String] = []
        for await event in SearchService.stream(regex: regex("needle"), root: root,
                                                include: "", exclude: "") {
            if case .file(let fm) = event { files.append(fm.displayPath) }
        }
        XCTAssertEqual(files, ["kept.txt"])
    }

    func testStreamEmitsTruncatedBeforeFinishedAtTheCap() async {
        for i in 0..<(SearchEngine.maxMatches + 5) { write("f\(i).txt", "needle\n") }

        var order: [String] = []
        for await event in SearchService.stream(regex: regex("needle"), root: root,
                                                include: "", exclude: "") {
            switch event {
            case .file:      break
            case .truncated: order.append("truncated")
            case .finished:  order.append("finished")
            }
        }
        XCTAssertEqual(order, ["truncated", "finished"])
    }

    /// DOCUMENTS a deliberate conservatism, not an accident: a run whose match
    /// total lands exactly ON the cap warns even though this particular tree
    /// dropped nothing. `SearchEngine.scan` cannot tell that case apart from
    /// one where the LAST file had matches its remaining budget refused, so the
    /// warning stays. See `SearchService.stream`'s doc comment.
    func testExactlyTheCapStillWarns() async {
        for i in 0..<SearchEngine.maxMatches { write("f\(i).txt", "needle\n") }

        var truncated = false
        var total = 0
        for await event in SearchService.stream(regex: regex("needle"), root: root,
                                                include: "", exclude: "") {
            switch event {
            case .file:                   break
            case .truncated:              truncated = true
            case .finished(let t, _):     total = t
            }
        }
        XCTAssertEqual(total, SearchEngine.maxMatches)
        XCTAssertTrue(truncated)
    }

    /// The empty-query guard, at its new home. It used to live inside the
    /// batch `search(...)` wrapper (deleted once `SearchView` consumed
    /// `stream` directly); `normalizedQuery` is that same rule, kept pure so
    /// it stays testable. `nil` is what makes `scheduleSearch` return before
    /// opening a stream — an empty pattern would otherwise match every
    /// position in every file in the repo.
    func testWhitespaceOnlyQueryIsNotSearchable() {
        XCTAssertNil(SearchService.normalizedQuery("   "))
        XCTAssertNil(SearchService.normalizedQuery(""))
        XCTAssertNil(SearchService.normalizedQuery("\u{20}\u{09}\u{0A}"))
        XCTAssertEqual(SearchService.normalizedQuery("  needle  "), "needle")
        XCTAssertEqual(SearchService.normalizedQuery("  設計.txt "), "設計.txt")
        // VERIFIED, not assumed: CharacterSet.whitespacesAndNewlines covers
        // Unicode Zs, so the full-width Japanese space U+3000 trims away too —
        // a lone 　 is not a searchable query. Unchanged from the deleted
        // wrapper, which trimmed with the same character set.
        XCTAssertNil(SearchService.normalizedQuery("\u{3000}"))
        // …but it is preserved INSIDE a query, so "a　b" stays searchable.
        XCTAssertEqual(SearchService.normalizedQuery(" a\u{3000}b "), "a\u{3000}b")
    }

    /// A consumer that walks away must terminate the walk instead of leaving a
    /// full-repo scan running — design §3 finding #8 / §9.
    ///
    /// The injected `readText` is what makes this observable AND deterministic:
    /// it counts the candidates the walk actually pulls, and its small sleep
    /// stops the producer (which `AsyncStream` never back-pressures) from
    /// finishing all 200 files before the consumer even resumes to `break`.
    func testAbandonedConsumerTerminatesTheWalk() async {
        for i in 0..<200 { write(String(format: "f%03d.txt", i), "needle\n") }
        let counter = ReadCounter()

        var seen = 0
        for await _ in SearchService.stream(regex: regex("needle"), root: root,
                                            include: "", exclude: "",
                                            readText: { url in
                                                counter.bump()
                                                Thread.sleep(forTimeInterval: 0.003)
                                                return try? String(contentsOf: url, encoding: .utf8)
                                            }) {
            seen += 1
            break
        }
        XCTAssertEqual(seen, 1)

        // Sample twice: the count must STOP, not merely be small right now.
        try? await Task.sleep(nanoseconds: 300_000_000)
        let first = counter.value
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(counter.value, first, "the walk kept reading after the consumer left")
        XCTAssertLessThan(first, 200, "the whole tree was read despite abandonment")
    }

    /// Minimal thread-safe counter — the reads happen on a detached task.
    private final class ReadCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func bump() { lock.lock(); count += 1; lock.unlock() }
        var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    }
}
