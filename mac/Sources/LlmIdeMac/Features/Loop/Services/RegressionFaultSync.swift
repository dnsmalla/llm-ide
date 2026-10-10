import CryptoKit
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
        // Parse every fault once: tag -> live (open/acknowledged) fault files.
        var live: [String: [URL]] = [:]
        for u in store.listFaults(at: gitRoot) {
            guard let f = try? store.loadFault(at: u), f.status == .open || f.status == .acknowledged else { continue }
            for t in f.tags where t.hasPrefix("test:") { live[t, default: []].append(u) }
        }
        let faultsDir = gitRoot.appendingPathComponent("system/faults", isDirectory: true)
        for id in diff.newFailures {
            let tag = "test:\(id)"
            if live[tag] != nil { out.skippedExisting.append(id); continue }
            let verify = VerifyCommandBuilder.command(
                runner: root?.runner ?? .make, testId: id,
                packageDir: root?.packageDir ?? "", fallback: suiteCommand)
            let fault = FaultReport(
                prompt: "Test regression: \(id)", response: "",
                notes: "Found by the Test loop run. Verify runs only this test.",
                severity: .major, reportedAt: Date(), gitHead: gitHead, appVersion: appVersion,
                agent: "loop", status: .open, tags: ["regression", "test-loop", tag],
                verify: verify, verifyKind: .command)
            // Same-second failures in one class share a slug: disambiguate by an id hash.
            var name = fault.suggestedFileName()
            if FileManager.default.fileExists(atPath: faultsDir.appendingPathComponent(name).path) {
                let h = SHA256.hash(data: Data(id.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
                name = String(name.dropLast(3)) + "-\(h).md"
            }
            let url = try store.writeFault(at: gitRoot, fault, fileName: name)
            live[tag] = [url]
            out.created.append(id)
        }
        for id in diff.fixed {
            guard let urls = live["test:\(id)"], !urls.isEmpty else { continue }
            for u in urls { try store.updateFaultStatus(at: u, to: .fixed) }
            out.markedFixed.append(id)
        }
        return out
    }
}
