import SwiftUI
import XCTest
@testable import LlmIdeMacLib

/// `LiveCaptureRegistry` contract: Library's meeting detail wraps its content
/// in `LiveCaptureGate` without naming Live, so an empty registry must fall
/// back to the caller's own content (never crash, never hide it), an install
/// must replace, and the request must reach the maker untouched. Fresh
/// instances per test — never `.shared`, which the app's boot path fills.
@MainActor
final class LiveCaptureRegistryTests: XCTestCase {
    private let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")

    func testFallbackRendersIdleContentWhenNothingInstalled() {
        let registry = LiveCaptureRegistry()
        var idleCalls = 0
        let request = LiveCaptureGateRequest(api: api, idle: {
            idleCalls += 1
            return AnyView(EmptyView())
        })

        _ = registry.make(request)

        XCTAssertFalse(registry.isInstalled)
        XCTAssertEqual(idleCalls, 1, "with no Live maker the caller's content must still show")
    }

    func testInstallReplacesPreviousMaker() {
        let registry = LiveCaptureRegistry()
        var firstCalls = 0
        var secondCalls = 0
        registry.install { _ in firstCalls += 1; return AnyView(EmptyView()) }
        registry.install { _ in secondCalls += 1; return AnyView(EmptyView()) }

        _ = registry.make(LiveCaptureGateRequest(api: api, idle: { AnyView(EmptyView()) }))

        XCTAssertTrue(registry.isInstalled)
        XCTAssertEqual(firstCalls, 0, "a replaced maker must never run")
        XCTAssertEqual(secondCalls, 1)
    }

    func testRequestPassesThroughToTheMaker() {
        let registry = LiveCaptureRegistry()
        var seenAPI: LlmIdeAPIClient?
        var idleCalls = 0
        registry.install { request in
            seenAPI = request.api
            return request.idle()
        }

        _ = registry.make(LiveCaptureGateRequest(api: api, idle: {
            idleCalls += 1
            return AnyView(EmptyView())
        }))

        XCTAssertTrue(seenAPI === api)
        XCTAssertEqual(idleCalls, 1, "the maker decides when the idle content renders")
    }
}
