import Testing
import Foundation
@testable import LlmIdeMacLib

/// Issue pagination must say when it stopped at the ceiling, so Sources→Issue
/// can fail closed instead of de-duping against a list missing old issues.
@MainActor
@Suite("Auto Task issue pagination")
struct AutoTaskIssuePaginationTests {
    @Test("A walk that reaches the last page is complete")
    func completeWalk() async throws {
        var calls = 0
        let result = try await AutoCodeUpdateService.paginateIssues(maxPages: 5) { page in
            calls += 1
            return RepoIssuePage(issues: [], hasMore: page < 3)
        }
        #expect(calls == 3)
        #expect(result.isComplete)
    }

    @Test("An empty page with hasMore keeps going (GitHub PR-only page)")
    func emptyPageIsNotTheEnd() async throws {
        var calls = 0
        let result = try await AutoCodeUpdateService.paginateIssues(maxPages: 5) { page in
            calls += 1
            return RepoIssuePage(issues: [], hasMore: page == 1)
        }
        #expect(calls == 2)
        #expect(result.isComplete)
    }

    @Test("Hitting the ceiling with more pages upstream is reported as incomplete")
    func truncatedWalk() async throws {
        var calls = 0
        let result = try await AutoCodeUpdateService.paginateIssues(maxPages: 4) { _ in
            calls += 1
            return RepoIssuePage(issues: [], hasMore: true)
        }
        #expect(calls == 4)
        #expect(!result.isComplete)
    }
}

/// A Self-Heal run's suppression window drops only what the run itself can
/// produce; a crash or another feature's UI error is still recorded.
@MainActor
@Suite("Incident suppression scope", .serialized)
struct IncidentSuppressionScopeTests {
    @Test("The Self-Heal scope covers log, server and the loop's own UI error only")
    func selfHealScope() {
        let scope = IncidentRecorder.SuppressionScope.selfHealRun
        #expect(scope.covers(source: .log, category: "API"))
        #expect(scope.covers(source: .server, category: "server"))
        #expect(scope.covers(source: .ui, category: "loop"))
        #expect(!scope.covers(source: .ui, category: "chat"))
        #expect(!scope.covers(source: .crash, category: "crash"))
    }

    @Test("Inside a window, out-of-scope incidents are still recorded")
    func outOfScopeIsRecorded() {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("scope-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let store = IncidentStore(fileURL: file)
        let token = IncidentRecorder.beginSuppression()
        defer { IncidentRecorder.endSuppression(token) }
        let now = Date()
        IncidentRecorder.record(source: .log, category: "API", message: "from the run", stack: nil,
                                at: now, into: store, eligible: true)
        IncidentRecorder.record(source: .ui, category: "loop", message: "loop failed", stack: nil,
                                at: now, into: store, eligible: true)
        #expect(store.incidents.isEmpty)
        IncidentRecorder.record(source: .ui, category: "chat", message: "chat broke", stack: nil,
                                at: now, into: store, eligible: true)
        IncidentRecorder.record(source: .crash, category: "crash", message: "crashed", stack: nil,
                                at: now, into: store, eligible: true)
        #expect(store.incidents.count == 2)
    }
}
