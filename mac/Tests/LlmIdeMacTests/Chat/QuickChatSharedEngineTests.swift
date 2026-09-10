import XCTest
@testable import LlmIdeMacLib

/// Guards decision 4 of the unified-quick-chat plan: the menu bar
/// (`MenuBarChatView`), the LLM Chat sheet (`LlmChatSheet`), and the phone
/// bridge (a later task) must all resolve the SAME `ChatEngine` instance for
/// `ChatScope.quick` via `ChatEngineRegistry`. Three engines each owning this
/// scope would be three engines writing a single session file — the
/// concurrent-holders bug that already resurrected deleted chats through
/// `persistCurrentChat` (see Task 5's report). This pins the one guarantee a
/// future refactor could quietly break: that `.quick` really is
/// registry-backed and not, say, constructed fresh per call site.
///
/// No other test in this target resolves `.quick` through the registry
/// (confirmed via `grep -rn "for: \.quick" Tests/`), so — unlike
/// `ChatEngineRegistryTests`, whose tests each had to claim a distinct scope
/// to avoid colliding on the same process-wide singleton with no reset hook —
/// this test doesn't need any extra isolation to stay safe.
@MainActor
final class QuickChatSharedEngineTests: XCTestCase {
    func testQuickScopeResolvesToOneEngineInstance() {
        // `LlmIdeAPIClient(baseURL:)` takes a `String`, not a `URL` — see
        // `HistoryForRequestTests.swift`'s doc comment and every construction
        // in `ChatEngineRegistryTests.swift` (`LlmIdeAPIClient(baseURL:
        // "http://127.0.0.1:3456")`). The registry's own doc comment notes
        // that a DIFFERENT `api` instance for the same scope still returns
        // the identical cached engine, so `api` here is not load-bearing.
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let a = ChatEngineRegistry.shared.engine(for: .quick, api: api)
        let b = ChatEngineRegistry.shared.engine(for: .quick, api: api)
        XCTAssertTrue(a === b, "the menu bar, the sheet and the phone must share ONE engine")
        XCTAssertEqual(a.scope, .quick)
    }
}
