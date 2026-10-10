import Foundation

/// Turns a Test-loop ledger diff into faults: one open fault per new failing test, closed when it is fixed.
struct RegressionFaultSync {
    var gitRoot: URL
    var store = MemoryStore()

    struct Outcome: Equatable {
        var created: [String]
        var markedFixed: [String]
        var skippedExisting: [String]
    }

    func apply(diff: TestLedger.Diff, root: TestRoot?, suiteCommand: String,
               gitHead: String?, appVersion: String) throws -> Outcome {
        var out = Outcome(created: [], markedFixed: [], skippedExisting: [])
        func isLive(_ f: FaultReport) -> Bool { f.status == .open || f.status == .acknowledged }
        func live(tag: String) -> [(URL, FaultReport)] {
            store.listFaults(at: gitRoot).compactMap { u in
                guard let f = try? store.loadFault(at: u), f.tags.contains(tag), isLive(f) else { return nil }
                return (u, f)
            }
        }
        for id in diff.newFailures {
            let tag = "test:\(id)"
            if !live(tag: tag).isEmpty { out.skippedExisting.append(id); continue }
            let verify = VerifyCommandBuilder.command(
                runner: root?.runner ?? .make, testId: id,
                packageDir: root?.packageDir ?? "", fallback: suiteCommand)
            try store.writeFault(at: gitRoot, FaultReport(
                prompt: "Test regression: \(id)", response: "",
                notes: "Found by the Test loop run. Verify runs only this test.",
                severity: .major, reportedAt: Date(), gitHead: gitHead, appVersion: appVersion,
                agent: "loop", status: .open, tags: ["regression", "test-loop", tag],
                verify: verify, verifyKind: .command))
            out.created.append(id)
        }
        for id in diff.fixed {
            let hits = live(tag: "test:\(id)")
            for (u, var f) in hits {
                f.status = .fixed
                try store.rewriteFault(at: u, f)
            }
            if !hits.isEmpty { out.markedFixed.append(id) }
        }
        return out
    }
}
