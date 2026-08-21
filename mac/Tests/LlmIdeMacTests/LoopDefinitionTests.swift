import XCTest
@testable import LlmIdeMacLib

final class LoopDefinitionTests: XCTestCase {
    private func makeConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
    }

    func testDefaultsWhenOnlyNameAndConfigAreGiven() {
        let loop = LoopDefinition(name: "Main Loop", config: makeConfig())
        XCTAssertFalse(loop.id.isEmpty)
        XCTAssertFalse(loop.isPrimary)
        XCTAssertNil(loop.goal)
        XCTAssertNil(loop.acceptanceCriteria)
        XCTAssertEqual(loop.scopeGlobs, [])
    }

    func testRoundTripPreservesEveryField() throws {
        let loop = LoopDefinition(id: "loop-1", name: "Fix flaky tests", isPrimary: true,
                                  goal: "Stabilize the auth test suite",
                                  acceptanceCriteria: "swift test passes 3 times in a row",
                                  scopeGlobs: ["mac/Tests/**"], config: makeConfig())
        let data = try JSONEncoder().encode(loop)
        let decoded = try JSONDecoder().decode(LoopDefinition.self, from: data)
        XCTAssertEqual(decoded, loop)
    }

    /// Every field beyond `name`/`config` must decode with a default when
    /// absent — the same rule `LoopStage.init(from:)` documents, so a future
    /// field addition here can't turn an old `LoopDefinition` into a decode
    /// failure.
    func testMissingOptionalKeysDecodeToDefaults() throws {
        let json = Data("""
        {"name":"Bare","config":{"stages":[]}}
        """.utf8)
        let decoded = try JSONDecoder().decode(LoopDefinition.self, from: json)
        XCTAssertEqual(decoded.name, "Bare")
        XCTAssertFalse(decoded.isPrimary)
        XCTAssertNil(decoded.goal)
        XCTAssertNil(decoded.acceptanceCriteria)
        XCTAssertEqual(decoded.scopeGlobs, [])
        XCTAssertFalse(decoded.id.isEmpty, "a missing id must still mint one, not decode as empty")
    }

    func testProjectStoreRoundTrips() throws {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Main Loop", isPrimary: true, config: makeConfig()),
            LoopDefinition(name: "Refactor auth", config: makeConfig())
        ])
        let data = try JSONEncoder().encode(store)
        let decoded = try JSONDecoder().decode(LoopEngineProjectStore.self, from: data)
        XCTAssertEqual(decoded, store)
    }
}
