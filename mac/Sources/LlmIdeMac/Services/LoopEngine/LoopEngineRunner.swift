import Foundation
import CryptoKit

/// Drives a Loop Engineering run: repeats the full ordered stage list,
/// on a `.shellCommand` failure calls `stageRepairer` and retries, on a
/// `.regressionSweep` failure just retries (the sweep already made its
/// own one-shot repair attempt internally). Every iteration re-runs
/// every stage from the top so a fix to a later stage can't silently
/// leave an earlier one broken.
@MainActor
final class LoopEngineRunner: ObservableObject {
    struct LogLine: Identifiable, Equatable {
        enum Level: Equatable { case info, warn, error }
        let id = UUID()
        let at: Date
        let level: Level
        let text: String
    }

    @Published private(set) var running = false
    @Published private(set) var log: [LogLine] = []
    @Published private(set) var status: LoopEngineStatus?
    @Published private(set) var iteration = 0

    private let verifier: FaultVerifier
    private let stageRepairer: LoopStageRepairer
    private let regressionSweep: RegressionSweepRunning
    private let approvals: VerifyApprovalStore
    private let stageTimeout: TimeInterval

    init(verifier: FaultVerifier = ShellFaultVerifier(),
         stageRepairer: LoopStageRepairer,
         regressionSweep: RegressionSweepRunning,
         approvals: VerifyApprovalStore = VerifyApprovalStore(),
         stageTimeout: TimeInterval = 600) {
        self.verifier = verifier
        self.stageRepairer = stageRepairer
        self.regressionSweep = regressionSweep
        self.approvals = approvals
        self.stageTimeout = stageTimeout
    }

    func clearLog() { log.removeAll() }

    /// Runs `config`'s ordered stages to completion, success, or give-up.
    /// Safe to call repeatedly — resets `status`/`iteration` each call.
    /// No-ops (returns immediately) if already running.
    ///
    /// - Parameters:
    ///   - faultsRoot: project root passed through to the regression sweep.
    ///   - gitRoot: git working tree shell-command stages run in and
    ///     approvals are keyed against.
    func run(config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL) async {
        guard !running else { return }
        running = true
        status = nil
        iteration = 0
        defer { running = false }

        let orderedStages = config.stages.sorted { $0.order < $1.order }
        var lastFailureHash: String?
        var consecutiveSameFailures = 0

        appendLog(.info, "Loop started · \(orderedStages.count) stage(s), max \(config.maxIterations) iteration(s)")

        iterationLoop: while iteration < config.maxIterations {
            iteration += 1
            appendLog(.info, "Iteration \(iteration)/\(config.maxIterations)")

            for stage in orderedStages {
                switch stage.kind {
                case .regressionSweep:
                    let passed = await regressionSweep.sweepPassed(
                        faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: true)
                    appendLog(passed ? .info : .warn, "  [\(stage.name)] \(passed ? "passed" : "failed")")
                    if !passed {
                        if iteration >= config.maxIterations {
                            status = .givenUp(reason: .maxIterations)
                            break iterationLoop
                        }
                        continue iterationLoop
                    }

                case .shellCommand:
                    guard let command = stage.command else {
                        status = .error("Stage \"\(stage.name)\" has no command")
                        break iterationLoop
                    }
                    guard approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) else {
                        appendLog(.warn, "  [\(stage.name)] needs approval: \(command)")
                        status = .needsApproval(stageName: stage.name)
                        break iterationLoop
                    }
                    do {
                        let outcome = try await verifier.verify(command: command, repoRoot: gitRoot, timeout: stageTimeout)
                        if outcome.exitCode == 0 {
                            appendLog(.info, "  [\(stage.name)] passed")
                            continue
                        }
                        appendLog(.warn, "  [\(stage.name)] FAILED (exit \(outcome.exitCode))")
                        let hash = Self.hash(outcome.output)
                        consecutiveSameFailures = (hash == lastFailureHash) ? consecutiveSameFailures + 1 : 1
                        lastFailureHash = hash
                        if consecutiveSameFailures >= config.consecutiveFailureStop {
                            status = .givenUp(reason: .repeatedFailure)
                            break iterationLoop
                        }
                        if iteration >= config.maxIterations {
                            status = .givenUp(reason: .maxIterations)
                            break iterationLoop
                        }
                        appendLog(.info, "  [\(stage.name)] repairing…")
                        try await stageRepairer.repair(
                            stageName: stage.name, command: command,
                            failureOutput: outcome.output, repoRoot: gitRoot)
                        continue iterationLoop
                    } catch {
                        status = .error("\(error)")
                        break iterationLoop
                    }
                }
            }

            if status == nil {
                status = .success
                break iterationLoop
            }
        }

        if status == nil { status = .givenUp(reason: .maxIterations) }
        appendLog(.info, "Loop finished · \(describe(status!))")
    }

    private func appendLog(_ level: LogLine.Level, _ text: String) {
        log.append(LogLine(at: Date(), level: level, text: text))
    }

    private static func hash(_ s: String) -> String {
        let digest = SHA256.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func describe(_ status: LoopEngineStatus) -> String {
        switch status {
        case .success: return "success"
        case .givenUp(.maxIterations): return "given up (max iterations)"
        case .givenUp(.repeatedFailure): return "given up (repeated failure)"
        case .needsApproval(let name): return "needs approval: \(name)"
        case .error(let msg): return "error: \(msg)"
        case .aborted: return "aborted"
        }
    }
}
