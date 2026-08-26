import XCTest
@testable import LlmIdeMacLib

/// The journal is the only durable record of what a loop run did. A silent
/// encode/decode break or a clobbered index turns every past run into nothing,
/// and because journalling is deliberately fail-open (it must never fail a run)
/// nothing else would surface the breakage.
final class LoopRunJournalTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        // Real temp dir, not the fake /tmp paths the runner tests use, because
        // these tests exercise actual file I/O.
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-journal-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    /// A millisecond-exact instant. The journal records timestamps at millisecond
    /// resolution (see `FileLoopRunJournal.iso8601`), so a `Date()` from the clock
    /// carries sub-millisecond bits that cannot survive the round trip and would
    /// make whole-record equality fail for a reason unrelated to what is tested.
    private static let fixedDate = Date(timeIntervalSince1970: 1_760_000_000.25)

    private func makeRecord(id: String = UUID().uuidString,
                            status: LoopEngineStatus = .success,
                            startedAt: Date = LoopRunJournalTests.fixedDate) -> LoopRunRecord {
        let stage = LoopStage(id: "t1", name: "Test", kind: .shellCommand,
                              command: "swift test", order: 0, severity: .blocking,
                              timeoutSeconds: 120)
        let attempt = LoopStageAttempt(
            stageId: "t1", stageName: "Test", kind: .shellCommand, severity: .blocking,
            startedAt: startedAt, durationSeconds: 1.5, exitCode: 1, passed: false,
            outputTail: "Executed 3 tests, with 2 failures", outputHash: "abc123",
            score: 2, repairAttempted: true, changedPaths: ["Sources/Foo.swift"],
            scopeVerdict: .clean)
        return LoopRunRecord(
            id: id, projectId: "proj-1", trigger: .autoTask, gitRoot: "/repo",
            startedAt: startedAt, endedAt: startedAt.addingTimeInterval(42),
            iterationsUsed: 2,
            config: LoopRunConfigSnapshot(LoopEngineConfig(stages: [stage])),
            iterations: [LoopIterationRecord(index: 1, attempts: [attempt])],
            statusCode: status.code, statusSummary: status.summary)
    }

    // MARK: - Round trip

    func testRecordRoundTripsThroughTheWrittenFile() throws {
        let journal = FileLoopRunJournal()
        let record = makeRecord()
        XCTAssertNil(journal.write(record, root: root))

        // Find the month-bucketed file the journal chose, rather than recomputing
        // the bucket here (which would just re-assert the formatter).
        let runsDir = FileLoopRunJournal.runsDirectory(root: root)
        let files = try FileManager.default
            .subpathsOfDirectory(atPath: runsDir.path)
            .filter { $0.hasSuffix("\(record.id).json") }
        XCTAssertEqual(files.count, 1, "expected exactly one record file for the run")

        let data = try Data(contentsOf: runsDir.appendingPathComponent(files[0]))
        // The journal's own decoder — timestamps are written with fractional
        // seconds, which `JSONDecoder`'s stock `.iso8601` cannot read back.
        let decoded = try FileLoopRunJournal.decoder().decode(LoopRunRecord.self, from: data)

        // Whole-value equality, so a field added later without an encode/decode
        // path fails here rather than being silently dropped.
        XCTAssertEqual(decoded, record)
    }

    func testLoadRecordReadsByIdAndStartedAt() {
        let journal = FileLoopRunJournal()
        let record = makeRecord(id: "load-me")
        XCTAssertNil(journal.write(record, root: root))
        XCTAssertEqual(journal.loadRecord(id: "load-me", startedAt: record.startedAt, root: root), record)
    }

    func testLoadRecordFallsBackToScanWhenBucketDiffers() {
        let journal = FileLoopRunJournal()
        let record = makeRecord(id: "scan-me")
        XCTAssertNil(journal.write(record, root: root))
        // Wrong month — scan should still find the file.
        let wrongMonth = record.startedAt.addingTimeInterval(90 * 24 * 3600)
        XCTAssertEqual(journal.loadRecord(id: "scan-me", startedAt: wrongMonth, root: root), record)
    }

    /// The bucket-mismatch fallback used to match on `hasSuffix`, so a short id
    /// resolved to any run whose filename merely ended with it.
    func testLoadRecordDoesNotMatchAnIdThatIsOnlyASuffix() {
        let journal = FileLoopRunJournal()
        XCTAssertNil(journal.write(makeRecord(id: "load-me"), root: root))
        XCTAssertNil(journal.loadRecord(id: "me", startedAt: Date(), root: root))
    }

    func testResolveRecordURLPointsAtTheFileLoadRecordUsed() throws {
        let journal = FileLoopRunJournal()
        let record = makeRecord(id: "resolve-me")
        XCTAssertNil(journal.write(record, root: root))
        let wrongMonth = record.startedAt.addingTimeInterval(90 * 24 * 3600)
        let url = try XCTUnwrap(
            journal.resolveRecordURL(id: "resolve-me", startedAt: wrongMonth, root: root))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    func testLoadRecordReturnsNilForMissingId() {
        XCTAssertNil(FileLoopRunJournal().loadRecord(id: "missing", startedAt: Date(), root: root))
    }

    func testDurationIsDerivedFromTheRecordedTimestamps() {
        XCTAssertEqual(makeRecord().durationSeconds, 42, accuracy: 0.001)
    }

    // MARK: - Index

    func testIndexAppendsRatherThanOverwriting() {
        let journal = FileLoopRunJournal()
        let base = Date()
        for offset in 0..<3 {
            XCTAssertNil(journal.write(
                makeRecord(startedAt: base.addingTimeInterval(Double(offset))), root: root))
        }
        XCTAssertEqual(journal.recentRuns(root: root, limit: 10).count, 3)
    }

    func testRecentRunsReturnsNewestFirst() {
        let journal = FileLoopRunJournal()
        let base = Date()
        let older = makeRecord(id: "older", startedAt: base)
        let newer = makeRecord(id: "newer", startedAt: base.addingTimeInterval(60))
        _ = journal.write(older, root: root)
        _ = journal.write(newer, root: root)

        XCTAssertEqual(journal.recentRuns(root: root, limit: 10).map(\.id), ["newer", "older"])
    }

    func testRecentRunsHonoursLimit() {
        let journal = FileLoopRunJournal()
        for _ in 0..<5 { _ = journal.write(makeRecord(), root: root) }
        XCTAssertEqual(journal.recentRuns(root: root, limit: 2).count, 2)
    }

    /// An absent journal is the normal state for a project that has never looped.
    func testRecentRunsOnAnEmptyRootReturnsEmptyNotAnError() {
        XCTAssertTrue(FileLoopRunJournal().recentRuns(root: root, limit: 10).isEmpty)
    }

    /// A crash mid-append leaves a truncated final line. That must cost exactly
    /// that one run, not the whole history — which is the reason the index is
    /// append-only JSONL rather than a single rewritten JSON array.
    func testTornFinalLineIsSkippedAndEarlierRunsSurvive() throws {
        let journal = FileLoopRunJournal()
        _ = journal.write(makeRecord(id: "intact"), root: root)

        let indexURL = FileLoopRunJournal.indexURL(root: root)
        let handle = try FileHandle(forWritingTo: indexURL)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(#"{"id":"torn","trigg"#.utf8))
        try handle.close()

        XCTAssertEqual(journal.recentRuns(root: root, limit: 10).map(\.id), ["intact"])
    }

    // MARK: - Failure reporting

    /// The journal reports failure by returning a reason rather than throwing,
    /// precisely so `LoopEngineRunner.finish` cannot accidentally propagate a
    /// telemetry problem into the run's verdict.
    func testWriteToAnUnwritableRootReportsAReasonInsteadOfThrowing() {
        let unwritable = URL(fileURLWithPath: "/dev/null/nope")
        XCTAssertNotNil(FileLoopRunJournal().write(makeRecord(), root: unwritable))
    }

    // MARK: - Config snapshot

    /// The snapshot exists so a run stays interpretable after the user edits the
    /// config. It must therefore capture the budgets, not just the stage names.
    func testConfigSnapshotCapturesBudgetsAndStageDetail() {
        let config = LoopEngineConfig(
            stages: [
                LoopStage(id: "b", name: "Lint", kind: .shellCommand, command: "make lint",
                          order: 1, severity: .advisory, timeoutSeconds: 30),
                LoopStage(id: "a", name: "Regression", kind: .regressionSweep, order: 0)
            ],
            maxIterations: 4, consecutiveFailureStop: 3,
            wallClockBudgetSeconds: 900, maxRepairsPerStage: 2,
            protectedPathPolicy: .stop)
        let snapshot = LoopRunConfigSnapshot(config)

        // Sorted by order, matching the sequence the run actually executed.
        XCTAssertEqual(snapshot.stages.map(\.name), ["Regression", "Lint"])
        XCTAssertEqual(snapshot.stages[1].severity, .advisory)
        XCTAssertEqual(snapshot.stages[1].timeoutSeconds, 30)
        XCTAssertEqual(snapshot.maxIterations, 4)
        XCTAssertEqual(snapshot.consecutiveFailureStop, 3)
        XCTAssertEqual(snapshot.wallClockBudgetSeconds, 900)
        XCTAssertEqual(snapshot.maxRepairsPerStage, 2)
        XCTAssertEqual(snapshot.protectedPathPolicy, .stop)
    }

    // MARK: - Loop identity

    func testLoopIdAndLoopNameRoundTripThroughEncodeDecode() throws {
        var record = LoopRunRecord(
            id: "run-1", projectId: "proj-1", trigger: .manual, gitRoot: "/tmp/repo",
            startedAt: Date(), endedAt: Date(), iterationsUsed: 1,
            config: LoopRunConfigSnapshot(LoopEngineConfig(stages: [])),
            iterations: [], statusCode: "success", statusSummary: "done")
        record.loopId = "loop-1"
        record.loopName = "Fix flaky tests"

        let data = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(LoopRunRecord.self, from: data)
        XCTAssertEqual(decoded.loopId, "loop-1")
        XCTAssertEqual(decoded.loopName, "Fix flaky tests")

        let indexEntry = LoopRunIndexEntry(decoded)
        XCTAssertEqual(indexEntry.loopId, "loop-1")
        XCTAssertEqual(indexEntry.loopName, "Fix flaky tests")
    }

    /// A record written before this feature existed has no `loopId` key at
    /// all — it must decode as `nil`, not fail, since `system/loop-runs/`
    /// is append-only and never migrated.
    func testRecordWithoutLoopIdKeyDecodesAsNil() throws {
        let json = Data("""
        {"id":"run-0","trigger":"manual","gitRoot":"/tmp/repo",
         "startedAt":0,"endedAt":0,"iterationsUsed":1,
         "config":{"stages":[],"maxIterations":10,"consecutiveFailureStop":2,
                    "maxRepairsPerStage":3,"protectedPathPolicy":"revert"},
         "iterations":[],"statusCode":"success","statusSummary":"done"}
        """.utf8)
        let decoded = try JSONDecoder().decode(LoopRunRecord.self, from: json)
        XCTAssertNil(decoded.loopId)
        XCTAssertNil(decoded.loopName)
    }

    // MARK: - Status codes

    /// Journal `statusCode`s are the grouping key for any analysis across runs, so
    /// they must stay stable and stay distinct from each other.
    func testStatusCodesAreStableAndDistinct() {
        let statuses: [LoopEngineStatus] = [
            .success,
            .givenUp(reason: .maxIterations),
            .givenUp(reason: .repeatedFailure),
            .givenUp(reason: .regressionStalled),
            .givenUp(reason: .noProgress(stageName: "Test")),
            .givenUp(reason: .wallClockExceeded),
            .givenUp(reason: .repairBudgetExhausted(stageName: "Test")),
            .blocked(reason: .repairOutOfScope(stageName: "Test", paths: ["a"])),
            .needsApproval(stageName: "Test"),
            .error("boom"),
            .aborted
        ]
        XCTAssertEqual(Set(statuses.map(\.code)).count, statuses.count)

        // A code must not vary with the stage name or path list it carries, or
        // grouping by it would produce one bucket per run.
        XCTAssertEqual(LoopEngineStatus.givenUp(reason: .noProgress(stageName: "A")).code,
                       LoopEngineStatus.givenUp(reason: .noProgress(stageName: "B")).code)
        XCTAssertEqual(
            LoopEngineStatus.blocked(reason: .repairOutOfScope(stageName: "A", paths: ["x"])).code,
            LoopEngineStatus.blocked(reason: .repairOutOfScope(stageName: "B", paths: ["y"])).code)
    }
}
