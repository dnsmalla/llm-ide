// The Agent history card's Clear flow: dry run, confirm with the preview id, and
// a stale preview is counted again instead of deleting anything. Cancelling
// abandons a preview in flight; the real delete cannot be abandoned.
import XCTest
@testable import LlmIdeMacLib

/// Holds a call open until the test opens it, so a cancel can land mid-request.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { cont in
            lock.lock()
            if isOpen {
                lock.unlock()
                cont.resume()
            } else {
                waiters.append(cont)
                lock.unlock()
            }
        }
    }

    func open() {
        lock.lock()
        isOpen = true
        let pending = waiters
        waiters = []
        lock.unlock()
        pending.forEach { $0.resume() }
    }
}

@MainActor
final class AgentHistoryModelTests: XCTestCase {

    typealias Scope = LlmIdeAPIClient.AgentHistoryClearScope
    typealias Result_ = LlmIdeAPIClient.AgentHistoryClearResult

    /// Scripted answers; every call is recorded so a test can check what was sent.
    final class FakeAPI: AgentHistoryAPI {
        var report: LlmIdeAPIClient.StorageReport
        var reportError: Error?
        var settings = LlmIdeAPIClient.AgentHistorySettings(retentionDays: 30, rollupKeepDays: 400, min: 7, max: 365)
        var previews: [Result<Result_, Error>] = []
        var performs: [Result<Result_, Error>] = []
        var previewGate: Gate?
        var performGate: Gate?
        var compact: Result<LlmIdeAPIClient.AgentHistoryCompactResult, Error>?
        private(set) var storageCalls = 0
        private(set) var previewCalls: [Scope] = []
        private(set) var previewBeforeDays: [Int?] = []
        private(set) var performBeforeDays: [Int?] = []
        private(set) var performedIds: [String] = []
        private(set) var retentionSaves: [Int] = []

        init(report: LlmIdeAPIClient.StorageReport) { self.report = report }

        func storageReport() async throws -> LlmIdeAPIClient.StorageReport {
            storageCalls += 1
            if let reportError { throw reportError }
            return report
        }
        func agentHistorySettings() async throws -> LlmIdeAPIClient.AgentHistorySettings { settings }
        func setAgentHistoryRetention(days: Int) async throws -> LlmIdeAPIClient.AgentHistorySettings {
            retentionSaves.append(days)
            settings = LlmIdeAPIClient.AgentHistorySettings(
                retentionDays: min(max(days, 7), 365), rollupKeepDays: 400, min: 7, max: 365)
            return settings
        }
        func previewAgentHistoryClear(scope: Scope, beforeDays: Int?) async throws -> Result_ {
            previewCalls.append(scope)
            previewBeforeDays.append(beforeDays)
            if let previewGate { await previewGate.wait() }
            return try previews.removeFirst().get()
        }
        func performAgentHistoryClear(scope: Scope, beforeDays: Int?, previewId: String) async throws -> Result_ {
            performedIds.append(previewId)
            performBeforeDays.append(beforeDays)
            if let performGate { await performGate.wait() }
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

    private static func staleError() -> Error {
        APIError.http(status: 409, code: "preview_stale", message: "changed", details: nil)
    }

    private func makeModel(_ api: FakeAPI) -> AgentHistoryModel {
        AgentHistoryModel(api: api)
    }

    /// Lets a started task run until `condition` holds (bounded, so a bug fails instead of hanging).
    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<10_000 where !condition() { await Task.yield() }
        XCTAssertTrue(condition(), "condition never held", file: file, line: line)
    }

    // MARK: - Load and retention

    func testLoadFillsReportAndRetentionDraft() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.load()
        XCTAssertNotNil(model.report)
        XCTAssertEqual(model.retentionDraft, 30)
        XCTAssertEqual(model.retentionRange, 7...365)
        XCTAssertFalse(model.retentionChanged)
    }

    func testFailedLoadKeepsErrorAndRetrySucceeds() async throws {
        let api = FakeAPI(report: try Self.report())
        api.reportError = APIError.http(status: 500, code: "INTERNAL_ERROR", message: "store offline", details: nil)
        let model = makeModel(api)
        await model.load()
        XCTAssertNil(model.report)
        XCTAssertEqual(model.loadError, "store offline")

        api.reportError = nil
        await model.load()
        XCTAssertNotNil(model.report)
        XCTAssertNil(model.loadError)
    }

    func testSaveRetentionSendsDraftTakesClampedValueAndRefreshesReport() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.load()
        let callsAfterLoad = api.storageCalls
        model.retentionDraft = 1000
        XCTAssertTrue(model.retentionChanged)
        await model.saveRetention()
        XCTAssertEqual(api.retentionSaves, [1000])
        XCTAssertEqual(model.retentionDraft, 365)
        XCTAssertFalse(model.retentionChanged)
        XCTAssertTrue(model.retentionMessage?.contains("365") == true)
        XCTAssertEqual(api.storageCalls, callsAfterLoad + 1, "the report is refreshed after a save")
    }

    func testMovingTheStepperClearsTheSaveMessage() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.load()
        model.retentionDraft = 60
        await model.saveRetention()
        XCTAssertNotNil(model.retentionMessage)
        model.retentionDraft = 90
        XCTAssertNil(model.retentionMessage, "a message about the old draft must not stay up")
    }

    func testSaveRetentionIsNoOpWhenUnchanged() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.load()
        await model.saveRetention()
        XCTAssertTrue(api.retentionSaves.isEmpty)
    }

    // MARK: - Clear: happy path

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

    func testConfirmWithoutPreviewDoesNothing() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.confirmClear()
        XCTAssertTrue(api.performedIds.isEmpty)
        XCTAssertEqual(model.clearPhase, .idle)
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

    // MARK: - Clear: stale previews

    func testStalePreviewIsCountedAgainAndNothingIsDeleted() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [
            .success(Self.preview(total: 5, id: "id-1")),
            .success(Self.preview(total: 7, id: "id-2")),
        ]
        api.performs = [.failure(Self.staleError())]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.confirmClear()
        XCTAssertEqual(api.previewCalls, [.raw, .raw], "a fresh dry run is made")
        XCTAssertEqual(model.clearPhase, .confirming(.raw, Self.preview(total: 7, id: "id-2")))
        XCTAssertEqual(model.clearNotice, AgentHistoryMessages.staleNotice(for: Self.staleError()))
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

    func testFailedRecountShowsTheFailureNotAStaleNotice() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [
            .success(Self.preview(total: 5, id: "id-1")),
            .failure(APIError.http(status: 500, code: "INTERNAL_ERROR", message: "recount broke", details: nil)),
        ]
        api.performs = [.failure(Self.staleError())]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.confirmClear()
        XCTAssertEqual(model.clearPhase, .failed("recount broke"))
        XCTAssertNil(model.clearNotice, "no 'counted again' notice when the recount did not happen")
        XCTAssertEqual(api.performedIds, ["id-1"])
    }

    // MARK: - Clear: cancel, late results, overlap

    func testCancelDuringPreviewDropsTheLateResult() async throws {
        let api = FakeAPI(report: try Self.report())
        let gate = Gate()
        api.previewGate = gate
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        let model = makeModel(api)
        let task = Task { await model.beginClear(scope: .raw) }
        await waitUntil { model.clearPhase == .previewing(.raw) }

        model.cancelClear()
        XCTAssertEqual(model.clearPhase, .idle)
        XCTAssertFalse(model.clearPhase.isPresented)

        // The request ignores cancellation and answers late; the answer must not reopen the sheet.
        gate.open()
        await task.value
        XCTAssertEqual(model.clearPhase, .idle)
        XCTAssertNil(model.clearNotice)
        XCTAssertTrue(api.performedIds.isEmpty)
    }

    func testCancelDuringRecountDropsTheRecountAndItsNotice() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        api.performs = [.failure(Self.staleError())]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)

        // Hold the recount, which runs inside the confirm step.
        let gate = Gate()
        api.previewGate = gate
        api.previews.append(.success(Self.preview(total: 7, id: "id-2")))
        let confirm = Task { await model.confirmClear() }
        await waitUntil { model.clearPhase == .previewing(.raw) }

        model.cancelClear()
        gate.open()
        await confirm.value
        XCTAssertEqual(model.clearPhase, .idle, "a cancelled recount must not reopen the sheet")
        XCTAssertNil(model.clearNotice)
        XCTAssertEqual(api.previewCalls.count, 2)
    }

    func testCancelDuringDeleteIsRefusedAndTheResultShows() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        api.performs = [.success(Self.deleted(total: 5))]
        let gate = Gate()
        api.performGate = gate
        let model = makeModel(api)
        await model.beginClear(scope: .raw)

        let confirm = Task { await model.confirmClear() }
        await waitUntil { model.clearPhase == .clearing(.raw) }
        XCTAssertFalse(model.canDismissClear, "the sheet cannot be dismissed during the delete")
        model.cancelClear()
        XCTAssertEqual(model.clearPhase, .clearing(.raw), "cancel is refused while deleting")

        gate.open()
        await confirm.value
        XCTAssertEqual(model.clearPhase, .cleared(Self.deleted(total: 5)))
    }

    func testOverlappingBeginClearStartsOnlyOneDryRun() async throws {
        let api = FakeAPI(report: try Self.report())
        let gate = Gate()
        api.previewGate = gate
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        let model = makeModel(api)
        let first = Task { await model.beginClear(scope: .raw) }
        await waitUntil { model.clearPhase == .previewing(.raw) }

        await model.beginClear(scope: .all)
        XCTAssertEqual(api.previewCalls, [.raw], "a second tap while a dry run runs is ignored")

        gate.open()
        await first.value
        XCTAssertEqual(model.clearPhase, .confirming(.raw, Self.preview(total: 5, id: "id-1")))
    }

    func testCancelClosesAConfirmedPreview() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 5, id: "id-1"))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        XCTAssertTrue(model.clearPhase.isPresented)
        model.cancelClear()
        XCTAssertEqual(model.clearPhase, .idle)
        XCTAssertTrue(api.performedIds.isEmpty)
    }

    // MARK: - Compact

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

    // MARK: - Helpers

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

    // MARK: - Clear by age

    func testDefaultClearSendsNoCutoff() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 1, id: "a"))]
        api.performs = [.success(Self.deleted(total: 1))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.confirmClear()
        XCTAssertEqual(api.previewBeforeDays, [nil])
        XCTAssertEqual(api.performBeforeDays, [nil])
    }

    func testAgeChoiceReachesPreviewAndRealClear() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 2, id: "a"))]
        api.performs = [.success(Self.deleted(total: 2))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw, age: .olderThan30)
        XCTAssertEqual(api.previewBeforeDays, [30])
        await model.confirmClear()
        XCTAssertEqual(api.performBeforeDays, [30])
        XCTAssertEqual(api.performedIds, ["a"])
    }

    func testChangingTheAgeRerunsThePreviewAndConfirmUsesTheNewId() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 9, id: "all")), .success(Self.preview(total: 3, id: "d7"))]
        api.performs = [.success(Self.deleted(total: 3))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        await model.setClearAge(.olderThan7)
        XCTAssertEqual(api.previewBeforeDays, [nil, 7])
        XCTAssertEqual(model.clearPhase, .confirming(.raw, Self.preview(total: 3, id: "d7")))
        await model.confirmClear()
        XCTAssertEqual(api.performedIds, ["d7"], "the old preview's id must never pair with the new age")
        XCTAssertEqual(api.performBeforeDays, [7])
    }

    func testChangingTheAgeDropsTheOldPreviewImmediately() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 9, id: "all")), .success(Self.preview(total: 3, id: "d90"))]
        let model = makeModel(api)
        await model.beginClear(scope: .raw)
        let gate = Gate()
        api.previewGate = gate
        let change = Task { await model.setClearAge(.olderThan90) }
        await waitUntil { model.clearPhase == .previewing(.raw) }
        await model.confirmClear()            // no preview to confirm while counting
        XCTAssertTrue(api.performedIds.isEmpty)
        gate.open()
        await change.value
        XCTAssertEqual(model.clearPhase, .confirming(.raw, Self.preview(total: 3, id: "d90")))
    }

    func testSettingTheSameAgeOrOutsideTheSheetDoesNothing() async throws {
        let api = FakeAPI(report: try Self.report())
        let model = makeModel(api)
        await model.setClearAge(.olderThan7)          // sheet closed
        XCTAssertTrue(api.previewBeforeDays.isEmpty)
        XCTAssertEqual(model.clearPhase, .idle)
        api.previews = [.success(Self.preview(total: 1, id: "a"))]
        await model.beginClear(scope: .raw)
        await model.setClearAge(.all)                 // same choice
        XCTAssertEqual(api.previewBeforeDays, [nil])
    }

    func testStalePreviewRecountKeepsTheAge() async throws {
        let api = FakeAPI(report: try Self.report())
        api.previews = [.success(Self.preview(total: 3, id: "a")), .success(Self.preview(total: 2, id: "b"))]
        api.performs = [.failure(Self.staleError())]
        let model = makeModel(api)
        await model.beginClear(scope: .raw, age: .olderThan90)
        await model.confirmClear()
        XCTAssertEqual(api.previewBeforeDays, [90, 90])
    }

    func testAgeWording() {
        XCTAssertEqual(AgentHistoryClearAge.allCases.map(\.beforeDays), [nil, 7, 30, 90])
        XCTAssertEqual(AgentHistoryClearAge.olderThan30.phrase, "older than 30 days")
    }
}
