import Testing
import Foundation
@testable import SharedProtocol

/// Opt-in live checks against the real APIs; skipped unless the variable is set. Never in CI.
///   LLMIDE_SP7_GITLAB_TOKEN=... LLMIDE_SP7_BOX_TOKEN=... swift test --filter SourceLiveTests
@MainActor
@Suite("Direct reads live (opt-in)")
struct SourceLiveTests {
    static let env = ProcessInfo.processInfo.environment
    func session(_ token: String) -> SourceSession { SourceSession(perMinute: 60, token: { token }, refresh: { nil }) }

    @Test("gitlab.com: projects, tree, open, search", .enabled(if: env["LLMIDE_SP7_GITLAB_TOKEN"] != nil))
    func gitlab() async throws {
        let c = GitLabReadClient(session: session(Self.env["LLMIDE_SP7_GITLAB_TOKEN"]!))
        let p = try #require(try await c.list(nil, cursor: nil).entries.first { $0.project?.ref.isEmpty == false })
        let tree = try await c.list(p, cursor: nil)
        #expect(!tree.entries.isEmpty)
        if let f = tree.entries.first(where: { $0.kind == .file }) { let o = try await c.open(f); #expect(o.text != nil || o.data != nil || o.reason != nil) }
        _ = try await c.search("readme", within: p)
    }

    @Test("Box: root, open, search", .enabled(if: env["LLMIDE_SP7_BOX_TOKEN"] != nil))
    func box() async throws {
        let c = BoxReadClient(session: session(Self.env["LLMIDE_SP7_BOX_TOKEN"]!))
        let root = try await c.list(nil, cursor: nil)
        if let f = root.entries.first(where: { $0.kind == .file }) { let o = try await c.open(f); #expect(o.text != nil || o.data != nil || o.reason != nil) }
        _ = try await c.search("a", within: nil)
    }
}
