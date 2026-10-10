import XCTest
@testable import LlmIdeMacLib

@MainActor final class LoopGraphRescannerTests: XCTestCase {
    private let repo = URL(fileURLWithPath: "/tmp/x")

    func testSuccessIsRewritten() async {
        let r = LoopGraphRescanner(generate: { _ in .success(()) }, retryDelay: .zero)
        let out = await r.rescan(repoRoot: repo)
        XCTAssertEqual(out, .rewritten)
    }

    func testBusyRetriesOnceThenReportsBusy() async {
        var calls = 0
        let r = LoopGraphRescanner(generate: { _ in calls += 1; return .failure(.busy) }, retryDelay: .zero)
        let out = await r.rescan(repoRoot: repo)
        XCTAssertEqual(out, .busy)
        XCTAssertEqual(calls, 2)
    }

    func testBusyThenSuccessIsRewritten() async {
        var calls = 0
        let r = LoopGraphRescanner(
            generate: { _ in calls += 1; return calls == 1 ? .failure(.busy) : .success(()) },
            retryDelay: .zero)
        let out = await r.rescan(repoRoot: repo)
        XCTAssertEqual(out, .rewritten)
        XCTAssertEqual(calls, 2)
    }

    func testOtherFailureIsUnavailable() async {
        var calls = 0
        let r = LoopGraphRescanner(generate: { _ in calls += 1; return .failure(.noEngine) }, retryDelay: .zero)
        let out = await r.rescan(repoRoot: repo)
        guard case .unavailable = out else { return XCTFail("expected unavailable, got \(out)") }
        XCTAssertEqual(calls, 1, "non-busy failures must not retry")
    }
}
