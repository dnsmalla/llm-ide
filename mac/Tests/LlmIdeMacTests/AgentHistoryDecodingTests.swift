// Decode-shape guard for the /kb/storage and /kb/agent-history/* answers
// (schema/http/agent-history.schema.json): catches server/client field-name drift.
import XCTest
@testable import LlmIdeMacLib

final class AgentHistoryDecodingTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testStorageReportDecodesGroupsAndAgentHistory() throws {
        let report = try decode(LlmIdeAPIClient.StorageReport.self, """
        {"generatedAt":"2026-10-28T09:00:00.000Z",
         "groups":[
           {"key":"agent_history","label":"Agent history","rows":5,"bytes":20480,"bytesApprox":true,
            "lastCleanedAt":null,"retentionDays":30,"actions":["clear","compact"]},
           {"key":"search_index","label":"Search index","rows":12,"bytes":null,"bytesApprox":null,
            "lastCleanedAt":null,"retentionDays":null,"actions":[]}],
         "agentHistory":{"rawFromDay":"2026-10-20","rawRows":5,"rolledDays":3,"oldestDay":"2026-09-01",
            "quarantinedAt":null,"droppedRows":0,"watermark":"2026-09-30"},
         "agentStore":{"health":"ok","state":"ok"}}
        """)
        XCTAssertEqual(report.groups.count, 2)
        let history = try XCTUnwrap(report.agentHistoryGroup)
        XCTAssertEqual(history.bytes, 20480)
        XCTAssertEqual(history.bytesApprox, true)
        XCTAssertNil(history.lastCleanedAt)
        XCTAssertTrue(history.canClear)
        XCTAssertTrue(history.canCompact)
        XCTAssertFalse(report.groups[1].canClear)
        XCTAssertNil(report.groups[1].bytes)
        XCTAssertEqual(report.agentHistory?.rawRows, 5)
        XCTAssertEqual(report.agentHistory?.watermark, "2026-09-30")
        XCTAssertEqual(report.agentStore.health, "ok")
    }

    func testStorageReportDecodesWhenStoreIsDown() throws {
        let report = try decode(LlmIdeAPIClient.StorageReport.self, """
        {"generatedAt":"2026-10-28T09:00:00.000Z","groups":[],"agentHistory":null,
         "agentStore":{"health":"down","state":"down"}}
        """)
        XCTAssertNil(report.agentHistory)
        XCTAssertNil(report.agentHistoryGroup)
        XCTAssertEqual(report.agentStore.state, "down")
    }

    func testSettingsDecodesRetentionBounds() throws {
        let settings = try decode(LlmIdeAPIClient.AgentHistorySettings.self,
                                  #"{"retentionDays":30,"rollupKeepDays":400,"min":7,"max":365}"#)
        XCTAssertEqual(settings.retentionDays, 30)
        XCTAssertEqual(settings.rollupKeepDays, 400)
        XCTAssertEqual(settings.min, 7)
        XCTAssertEqual(settings.max, 365)
    }

    func testDryRunClearDecodesCountsAndPreviewId() throws {
        let preview = try decode(LlmIdeAPIClient.AgentHistoryClearResult.self, """
        {"dryRun":true,"scope":"raw","beforeDays":30,
         "wouldDelete":{"agent_runs":2,"agent_tool_events":3,"turn_composition":0,"agent_daily":0,"agent_daily_tools":0},
         "total":5,"previewId":"abc.def","expiresAt":"2026-10-28T09:05:00.000Z"}
        """)
        XCTAssertTrue(preview.dryRun)
        XCTAssertEqual(preview.scope, .raw)
        XCTAssertEqual(preview.beforeDays, 30)
        XCTAssertEqual(preview.wouldDelete?.agentRuns, 2)
        XCTAssertEqual(preview.wouldDelete?.agentToolEvents, 3)
        XCTAssertEqual(preview.total, 5)
        XCTAssertEqual(preview.previewId, "abc.def")
        XCTAssertNil(preview.deleted)
    }

    func testRealClearDecodesDeletedCounts() throws {
        let done = try decode(LlmIdeAPIClient.AgentHistoryClearResult.self, """
        {"dryRun":false,"scope":"all","beforeDays":null,
         "deleted":{"agent_runs":2,"agent_tool_events":3,"turn_composition":1,"agent_daily":4,"agent_daily_tools":5},
         "total":15}
        """)
        XCTAssertFalse(done.dryRun)
        XCTAssertEqual(done.scope, .all)
        XCTAssertNil(done.beforeDays)
        XCTAssertEqual(done.deleted?.agentDailyTools, 5)
        XCTAssertEqual(done.total, 15)
        XCTAssertNil(done.previewId)
        XCTAssertNil(done.wouldDelete)
    }

    func testCompactDecodes() throws {
        let result = try decode(LlmIdeAPIClient.AgentHistoryCompactResult.self, """
        {"ok":true,"mode":"incremental","pagesFreed":120,"bytesBefore":524288,"bytesAfter":458752,"ms":4}
        """)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.mode, "incremental")
        XCTAssertEqual(result.pagesFreed, 120)
        XCTAssertEqual(result.bytesAfter, 458752)
    }

    func testClearScopeRejectsUnknownValue() {
        XCTAssertNil(LlmIdeAPIClient.AgentHistoryClearScope(rawValue: "everything"))
        XCTAssertEqual(LlmIdeAPIClient.AgentHistoryClearScope.raw.rawValue, "raw")
    }
}
