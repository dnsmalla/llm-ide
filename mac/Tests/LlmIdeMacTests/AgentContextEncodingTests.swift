import XCTest
@testable import LlmIdeMacLib

/// agentContext.activeRepoRoot is the server's preferred code-graph scope
/// (resolveRepoScope). It must encode under that exact key, and be absent
/// (not null) when unknown so older servers see an unchanged payload.
final class AgentContextEncodingTests: XCTestCase {
    private func json(_ ctx: AgentContext) throws -> [String: Any] {
        let data = try JSONEncoder().encode(ctx)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testActiveRepoRootEncodesUnderItsKey() throws {
        var ctx = AgentContext(activeProject: nil, indexedRepos: [])
        ctx.activeRepoRoot = "/Users/me/code/app"
        XCTAssertEqual(try json(ctx)["activeRepoRoot"] as? String, "/Users/me/code/app")
    }

    func testActiveRepoRootIsOmittedWhenNil() throws {
        let ctx = AgentContext(activeProject: nil, indexedRepos: [])
        XCTAssertNil(try json(ctx)["activeRepoRoot"])
    }
}
