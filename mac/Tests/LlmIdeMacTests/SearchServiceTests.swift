import Testing
import Foundation
@testable import LlmIdeMac

@MainActor @Suite struct SearchServiceTests {
    private func tmp() throws -> URL {
        let r = FileManager.default.temporaryDirectory.appendingPathComponent("se-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: r, withIntermediateDirectories: true)
        return r
    }
    @Test func matchesFilenameAndContent() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try "let alpha = 1\nlet beta = 2\n".write(to: root.appendingPathComponent("alpha.swift"), atomically: true, encoding: .utf8)
        try "nothing here\n".write(to: root.appendingPathComponent("other.txt"), atomically: true, encoding: .utf8)

        let svc = SearchService()
        let results = await svc.search(query: "alpha", root: root)

        // alpha.swift matches by NAME and by CONTENT (line 1)
        let m = results.first { $0.url.lastPathComponent == "alpha.swift" }
        #expect(m != nil)
        #expect(m?.nameMatched == true)
        #expect(m?.lines.contains { $0.line == 1 && $0.text.contains("alpha") } == true)
        // other.txt does not match
        #expect(!results.contains { $0.url.lastPathComponent == "other.txt" })
    }

    @Test func skipsBinaryAndNoiseAndEmptyQuery() async throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
        try "query\n".write(to: root.appendingPathComponent(".git/config"), atomically: true, encoding: .utf8)
        var bin = Data([0x00, 0x01, 0x02]); bin.append("query".data(using: .utf8)!)
        try bin.write(to: root.appendingPathComponent("blob.bin"))

        let svc = SearchService()
        #expect(await svc.search(query: "", root: root).isEmpty)          // empty query
        let r = await svc.search(query: "query", root: root)
        #expect(!r.contains { $0.url.path.contains("/.git/") })           // noise dir skipped
        #expect(!r.contains { $0.url.lastPathComponent == "blob.bin" })   // binary skipped
    }
}
