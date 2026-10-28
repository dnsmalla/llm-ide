// The Agent history card's Clear flow: dry run, confirm with the preview id, and
// a stale preview is counted again instead of deleting anything.
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AgentHistoryModelTests: XCTestCase {

    typealias Scope = LlmIdeAPIClient.AgentHistoryClearScope
    typealias Result_ = LlmIdeAPIClient.AgentHistoryClearResult

    /// Scripted answers; every call is recorded so a test can check what was sent.
    final class FakeAPI: AgentHistoryAPI {
        var report: LlmIdeAPIClient.StorageReport
        var settings = LlmIdeAPIClient.AgentHistorySettings(retentionDays: 30, rollupKeepDays: 400, min: 7, max: 365)
        var previews: [Result<Result_, Error>] = []
        var performs: [Result<Result_, Error>] = []
        var compact: Result<LlmIdeAPIClient.AgentHistoryCompactResult, Error>?
        private(set) var previewCalls: [Scope] = []
        private(set) var performedIds: [String] = []
        private(set) var retentionSaves: [Int] = []

        init(report: LlmIdeAPIClient.StorageReport) { self.report = report }

        func storageReport() async throws -> LlmIdeAPIClient.StorageReport { report }
        func agentHistorySettings() async throws -> LlmIdeAPIClient.AgentHistorySettings { settings }
        func setAgentHistoryRetention(days: Int) async throws -> LlmIdeAPIClient.AgentHistorySettings {
            retentionSaves.append(days)
            settings = LlmIdeAPIClient.AgentHistorySettings(
                retentionDays: min(max(days, 7), 365), rollupKeepDays: 400, min: 7, max: 365)
            return settings
        }
        func previewAgentHistoryClear(scope: Scope, beforeDays: Int?) async throws -> Result_ {
            previewCalls.append(scope)
            return try previews.removeFirst().get()
        }
        func performAgentHistoryClear(scope: Scope, beforeDays: Int?, previewId: String) async throws -> Result_ {
            performedIds.append(previewId)
            return try performs.removeFirst().get()
        }
        func compactAgentHistory() async throws -> LlmIdeAPIClient.AgentHistoryCompactResult {
            try (compact ?? .failure(APIError.http(status: 500, code: "INTERNAL_ERROR", message: "x", details: nil))).get()
        }
    }

    private static func report() throws -> LlmIdeAPIClient.StorageReport {
        try JSONDecoder().decode(LlmIdeAPIClient.StorageReport.self, from: Data("""
        {"generatedAt":"2026-10-28T09:00:00.000Z","groups":[],"agentHistory":null,
         "agentStore":{"health":"ok","state":"ok"}}
        """.utf8))
    }

    private static func preview(total: Int, id: String) -> Result_ {
        Result_(dryRun: true, scope: .raw, beforeDays: nil,
                wouldDelete: LlmIdeAPIClient.AgentHistoryClearCounts(
                    agentRuns: total, agentToolEvents: 0, turnComposition: 0, agentDaily: 0, agentDailyTools: 0),
                deleted: nil, total: total, previewId: id, expiresAt: nil)
    }

    private static func deleted(total: Int) -> Result_ {
        Result_(dryRun: false, scope: .raw, beforeDays: nil, wouldDelete: nil,
                deleted: LlmIdeAPIClient.AgentHistoryClearCounts(
                    agentRuns: total, agentToolEvents: 0, turnComposition: 0, agentDaily: 0, agentDailyTools: 0),
                total: total, previewId: nil, expiresAt: nil)
    }

    private func makeModel(_ api: FakeAPI) -> AgentHistoryModel {
        AgentHistoryModel(api: api)
    }

    func testLoadFillsReportAndRetentionDraft() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.load()
        XCTAssertNotNil(model.report)
        XCTAssertEqual(model.retentionDraft, 30)
        XCTAssertEqual(model.retentionRange, 7...365)
        XCTAssertFalse(model.retentionChanged)
    }

    func testBeginClearOnlyPreviews() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        XCTAssertEqual(model.clearPhase, .confirming(.raw, Self.preview(total: 5, id: "id-1")))
        XCTAssertEqual(api.previewCalls, [.raw])
        XCTAssertTrue(api.performedIds.isEmpty, "a dry run must not delete anything")
    }

    func testConfirmClearSendsThePreviewIdAndReportsDeletion() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        api.performs = [.success(Self.deleted(total: 5))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.confirmClear()
        XCTAssertEqual(api.performedIds, ["id-1"])
        XCTAssertEqual(model.clearPhase, .cleared(Self.deleted(total: 5)))
        XCTAssertEqual(AgentHistoryMessages.clearSuccess(Self.deleted(total: 5)), "Deleted 5 rows.")
    }

    func testStalePreviewIsCountedAgainAndNothingIsDeleted() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [
            .success(Self.preview(total: 5, id: "id-1")),
            .success(Self.preview(total: 7, id: "id-2")),
        ]
        api.performs = [.failure(APIError.http(status: 409, code: "preview_stale",
                                               message: "changed", details: nil))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.confirmClear()
        XCTAssertEqual(api.previewCalls, [.raw, .raw], "a fresh dry run is made")
        XCTAssertEqual(model.clearPhase, .confirming(.raw, Self.preview(total: 7, id: "id-2")))
        XCTAssertEqual(model.clearNotice, AgentHistoryMessages.staleNotice(for: APIError.http(
            status: 409, code: "preview_stale", message: "changed", details: nil)))
        XCTAssertTrue(model.clearNotice?.contains("counted again") == true)
        XCTAssertEqual(api.performedIds, ["id-1"], "the user confirms the new counts before any delete")
    }

    func testExpiredPreviewGetsAFreshPreview() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [
            .success(Self.preview(total: 5, id: "id-1")),
            .success(Self.preview(total: 5, id: "id-2")),
        ]
        api.performs = [.failure(APIError.http(status: 400, code: "PREVIEW_EXPIRED",
                                               message: "expired", details: nil))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.confirmClear()
        XCTAssertEqual(model.clearPhase, .confirming(.raw, Self.preview(total: 5, id: "id-2")))
        XCTAssertTrue(model.clearNotice?.contains("expired") == true)
    }

    func testOtherClearErrorShowsServerMessage() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        api.performs = [.failure(APIError.http(status: 500, code: "INTERNAL_ERROR",
                                               message: "disk on fire", details: nil))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.confirmClear()
        XCTAssertEqual(model.clearPhase, .failed("disk on fire"))
        XCTAssertNil(model.clearNotice)
    }

    func testPreviewFailureOpensFailedPhase() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.failure(APIError.http(status: 503, code: "AGENT_STORE_UNAVAILABLE",
                                               message: "store down", details: nil))]
        let model = makeModel(api)
        await model.beginClear(scope: .all)
        XCTAssertEqual(model.clearPhase, .failed("store down"))
    }

    func testConfirmWithoutPreviewDoesNothing() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.confirmClear()
        XCTAssertTrue(api.performedIds.isEmpty)
        XCTAssertEqual(model.clearPhase, .idle)
    }

    func testCancelClosesTheSheet() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        XCTAssertTrue(model.clearPhase.isPresented)
        model.cancelClear()
        XCTAssertEqual(model.clearPhase, .idle)
        XCTAssertFalse(model.clearPhase.isPresented)
    }

    func testCompactBusyShowsWaitMessage() async throws {
        let api = FakeAPI(report: try Self.report())
        api.compact = .failure(APIError.http(status: 409, code: "busy", message: "in flight", details: nil))
        let model = makeModel(api)
        await model.compact()
        XCTAssertTrue(model.compactIsError)
        XCTAssertEqual(model.compactMessage, AgentHistoryMessages.compactFailure(
            APIError.http(status: 409, code: "busy", message: "in flight", details: nil)))
        XCTAssertTrue(model.compactMessage?.contains("in progress") == true)
    }

    func testCompactSuccessReportsFreedPages() async throws {
        let api = FakeAPI(report: try Self.report())
        api.compact = .success(LlmIdeAPIClient.AgentHistoryCompactResult(
            ok: true, mode: "incremental", pagesFreed: 120, bytesBefore: 524288, bytesAfter: 458752, ms: 4))
        let model = makeModel(api)
        await model.compact()
        XCTAssertFalse(model.compactIsError)
        XCTAssertTrue(model.compactMessage?.contains("freed 120 pages") == true)
        XCTAssertFalse(model.compacting)
    }

    func testCompactFailureMessages() {
        func err(_ code: String) -> Error { APIError.http(status: 500, code: code, message: "server said", details: nil) }
        XCTAssertTrue(AgentHistoryMessages.compactFailure(err("disk_space")).contains("disk space"))
        XCTAssertTrue(AgentHistoryMessages.compactFailure(err("AGENT_STORE_UNAVAILABLE")).contains("not available"))
        XCTAssertEqual(AgentHistoryMessages.compactFailure(err("other")), "server said")
    }

    func testSaveRetentionSendsDraftAndTakesClampedValue() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.load()
        model.retentionDraft = 1000
        XCTAssertTrue(model.retentionChanged)
        await model.saveRetention()
        XCTAssertEqual(api.retentionSaves, [1000])
        XCTAssertEqual(model.retentionDraft, 365)
        XCTAssertFalse(model.retentionChanged)
        XCTAssertTrue(model.retentionMessage?.contains("365") == true)
    }

    func testSaveRetentionIsNoOpWhenUnchanged() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.load()
        await model.saveRetention()
        XCTAssertTrue(api.retentionSaves.isEmpty)
    }

    func testStaleNoticeCoversEachStaleCode() {
        func err(_ code: String) -> Error { APIError.http(status: 400, code: code, message: "m", details: nil) }
        XCTAssertTrue(AgentHistoryMessages.staleNotice(for: err("PREVIEW_EXPIRED")).contains("expired"))
        XCTAssertTrue(AgentHistoryMessages.staleNotice(for: err("preview_stale")).contains("changed"))
        XCTAssertTrue(AgentHistoryMessages.staleNotice(for: err("PREVIEW_INVALID")).contains("no longer matches"))
        XCTAssertTrue(AgentHistoryMessages.isStalePreview(err("PREVIEW_INVALID")))
        XCTAssertFalse(AgentHistoryMessages.isStalePreview(err("PREVIEW_REQUIRED")))
    }

    func testDateParsingAcceptsFractionalAndPlainIso() {
        XCTAssertNotNil(AgentHistoryDates.parse("2026-10-28T09:00:00.000Z"))
        XCTAssertNotNil(AgentHistoryDates.parse("2026-10-28T09:00:00Z"))
        XCTAssertNil(AgentHistoryDates.parse("yesterday"))
    }
}
