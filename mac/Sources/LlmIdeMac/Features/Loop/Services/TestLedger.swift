import Foundation

/// The last Test-loop run's failing/passing test ids, persisted so the next run can diff against it.
struct TestLedger: Codable, Equatable {
    var runId: String
    var recordedAt: Date
    var failing: [String]
    var passing: [String]   // ids seen passing (XCTest "passed" lines; other runners: empty)

    struct Diff: Equatable {
        var newFailures: [String]
        var stillFailing: [String]
        var fixed: [String]
    }

    private static func url(_ gitRoot: URL) -> URL {
        gitRoot.appendingPathComponent(LoopOutputLayout.testLedger)
    }

    static func load(gitRoot: URL) -> TestLedger? {
        guard let data = try? Data(contentsOf: url(gitRoot)) else { return nil }
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601
        return try? d.decode(TestLedger.self, from: data)
    }

    func write(gitRoot: URL) throws {
        let u = Self.url(gitRoot)
        try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        try e.encode(self).write(to: u, options: .atomic)
    }

    /// `fixed` = previously failing, no longer failing, and either seen passing or `runPassed`.
    /// The caller MUST pass the Test stage's real exit status as `runPassed`: an empty failing
    /// list alone is also what a crashed or timed-out run looks like.
    static func diff(previous: TestLedger?, currentFailing: [String], currentPassing: [String],
                     runPassed: Bool) -> Diff {
        let prevFailing = previous?.failing ?? []
        let cur = Set(currentFailing), pass = Set(currentPassing), prev = Set(prevFailing)
        return Diff(
            newFailures: currentFailing.filter { !prev.contains($0) },
            stillFailing: currentFailing.filter { prev.contains($0) },
            fixed: prevFailing.filter { !cur.contains($0) && (runPassed || pass.contains($0)) })
    }
}
