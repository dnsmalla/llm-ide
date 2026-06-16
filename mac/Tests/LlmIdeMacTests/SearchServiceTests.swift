import Testing
import Foundation
@testable import LlmIdeMac

@MainActor @Suite struct SearchServiceTests {
    private func tmp() throws -> URL {
        let r = FileManager.default.temporaryDirectory.appendingPathComponent("se-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: r, withIntermediateDirectories: true)
        return r
    }
    @Test func matchesContent() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try "let alpha = 1\nlet beta = 2\n".write(to: root.appendingPathComponent("alpha.swift"), atomically: true, encoding: .utf8)
        try "nothing here\n".write(to: root.appendingPathComponent("other.txt"), atomically: true, encoding: .utf8)

        let svc = SearchService()
        let results = await svc.search(query: "alpha", root: root, options: SearchOptions(), include: "", exclude: "")

        let m = results.files.first { $0.url.lastPathComponent == "alpha.swift" }
        #expect(m != nil)
        #expect(m?.lineMatches.contains { $0.line == 1 && $0.lineText.contains("alpha") } == true)
        // content-only match: other.txt has no "alpha"
        #expect(!results.files.contains { $0.url.lastPathComponent == "other.txt" })
    }

    @Test func skipsBinaryAndNoiseAndEmptyQuery() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
        try "query\n".write(to: root.appendingPathComponent(".git/config"), atomically: true, encoding: .utf8)
        var bin = Data([0x00, 0x01, 0x02]); bin.append("query".data(using: .utf8)!)
        try bin.write(to: root.appendingPathComponent("blob.bin"))

        let svc = SearchService()
        #expect(await svc.search(query: "", root: root, options: SearchOptions(), include: "", exclude: "").files.isEmpty)
        let r = await svc.search(query: "query", root: root, options: SearchOptions(), include: "", exclude: "")
        #expect(!r.files.contains { $0.url.path.contains("/.git/") })
        #expect(!r.files.contains { $0.url.lastPathComponent == "blob.bin" })
    }

    @Test func includeExcludeGlobs() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try "hit one\n".write(to: root.appendingPathComponent("a.py"), atomically: true, encoding: .utf8)
        try "hit two\n".write(to: root.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)

        let svc = SearchService()
        let inc = await svc.search(query: "hit", root: root, options: SearchOptions(), include: "*.py", exclude: "")
        #expect(inc.files.count == 1)
        #expect(inc.files.first?.url.lastPathComponent == "a.py")

        let exc = await svc.search(query: "hit", root: root, options: SearchOptions(), include: "", exclude: "*.txt")
        #expect(exc.files.count == 1)
        #expect(exc.files.first?.url.lastPathComponent == "a.py")
    }

    @Test func regexAndWholeWordAndCase() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try "foo foobar Foo\n".write(to: root.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)

        let svc = SearchService()
        // whole word "foo" → matches "foo" and "Foo" (case-insensitive default), not "foobar"
        let ww = await svc.search(query: "foo", root: root, options: SearchOptions(caseSensitive: false, wholeWord: true, regex: false), include: "", exclude: "")
        #expect(ww.totalMatches == 2)
        // case-sensitive plain "foo" → "foo" + the "foo" inside "foobar" = 2, not "Foo"
        let cs = await svc.search(query: "foo", root: root, options: SearchOptions(caseSensitive: true, wholeWord: false, regex: false), include: "", exclude: "")
        #expect(cs.totalMatches == 2)
        // regex, case-sensitive: "fo+" matches "foo" (standalone) + "foo" inside
        // "foobar" = 2; "Foo" does NOT match case-sensitively.
        let rx = await svc.search(query: "fo+", root: root, options: SearchOptions(caseSensitive: true, wholeWord: false, regex: true), include: "", exclude: "")
        #expect(rx.totalMatches == 2)
    }

    @Test func invalidRegexFlagsInvalidPattern() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try "x\n".write(to: root.appendingPathComponent("x.txt"), atomically: true, encoding: .utf8)
        let svc = SearchService()
        let r = await svc.search(query: "(unclosed", root: root, options: SearchOptions(caseSensitive: false, wholeWord: false, regex: true), include: "", exclude: "")
        #expect(r.invalidPattern)
        #expect(r.files.isEmpty)
    }

    @Test func multibyteNSRangeIsUTF16Correct() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        let line = "# 出力調整禁止: フラグ"
        try (line + "\n").write(to: root.appendingPathComponent("ja.txt"), atomically: true, encoding: .utf8)
        let svc = SearchService()
        let r = await svc.search(query: "出力調整禁止", root: root, options: SearchOptions(), include: "", exclude: "")
        let lm = r.files.first?.lineMatches.first
        #expect(lm != nil)
        let m = try #require(lm?.matches.first)
        let sliced = (lm!.lineText as NSString).substring(with: m.nsRange)
        #expect(sliced == "出力調整禁止")
    }

    @Test func preserveCaseTransform() {
        // all-upper → upper; Capitalized → capitalize; lower/mixed → verbatim
        #expect(SearchService.preserveCaseReplacement(matched: "FOO", replacement: "bar") == "BAR")
        #expect(SearchService.preserveCaseReplacement(matched: "Foo", replacement: "bar") == "Bar")
        #expect(SearchService.preserveCaseReplacement(matched: "foo", replacement: "bar") == "bar")
    }

    @Test func replaceInFileLiteralAndPreserveCase() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        let f = root.appendingPathComponent("r.txt")
        let svc = SearchService()
        // case-sensitive literal: only lowercase "foo" changes
        try "foo Foo FOO\n".write(to: f, atomically: true, encoding: .utf8)
        _ = await svc.replaceInFile(file: f, query: "foo", options: SearchOptions(caseSensitive: true), replacement: "bar", preserveCase: false)
        #expect((try String(contentsOf: f, encoding: .utf8)) == "bar Foo FOO\n")
        // preserve-case, case-insensitive: each match adapts
        try "foo Foo FOO\n".write(to: f, atomically: true, encoding: .utf8)
        _ = await svc.replaceInFile(file: f, query: "foo", options: SearchOptions(), replacement: "bar", preserveCase: true)
        #expect((try String(contentsOf: f, encoding: .utf8)) == "bar Bar BAR\n")
    }

    @Test func replaceOneTargetsTheIndexedOccurrence() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        let f = root.appendingPathComponent("o.txt")
        try "aa zz aa zz aa\n".write(to: f, atomically: true, encoding: .utf8)
        let svc = SearchService()
        // replace only the 2nd "aa" (fileIndex 1, document order)
        _ = await svc.replaceOne(file: f, fileIndex: 1, query: "aa", options: SearchOptions(caseSensitive: true), replacement: "QQ", preserveCase: false)
        #expect((try String(contentsOf: f, encoding: .utf8)) == "aa zz QQ zz aa\n")
    }

    @Test func anchoredRegexReplaceMatchesPerLineLikeSearch() async throws {
        // Regression guard: search indexes per-line; replace matches full text.
        // `.anchorsMatchLines` keeps `$` a per-line anchor on BOTH sides so the
        // fileIndex order matches and replaceOne targets the right occurrence.
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        let f = root.appendingPathComponent("a.txt")
        try "foo end\nstart foo\nfoo\n".write(to: f, atomically: true, encoding: .utf8)
        let svc = SearchService()
        let opts = SearchOptions(caseSensitive: true, wholeWord: false, regex: true)
        let r = await svc.search(query: "foo$", root: root, options: opts, include: "", exclude: "")
        // search sees the line-2 and line-3 trailing "foo" (not line-1's, which has " end" after)
        #expect(r.totalMatches == 2)
        // replace-all-in-file changes exactly those two
        _ = await svc.replaceInFile(file: f, query: "foo$", options: opts, replacement: "X", preserveCase: false)
        #expect((try String(contentsOf: f, encoding: .utf8)) == "foo end\nstart X\nX\n")
    }
}
