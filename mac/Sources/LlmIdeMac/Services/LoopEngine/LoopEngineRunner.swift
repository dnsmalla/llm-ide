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

    /// Process-wide set of git roots with a run currently in flight,
    /// keyed by standardized filesystem path. Guards against two
    /// *different* `LoopEngineRunner` instances (e.g. a chat-triggered
    /// run and a scheduled Auto Task run — the design spec explicitly
    /// promises these are rejected the same way) racing on the same
    /// working tree. The instance-scoped `running` flag alone can't
    /// catch that, since each caller constructs its own runner instance.
    @MainActor private static var activeRoots: Set<String> = []

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
    ///
    /// Returns `nil` when the run never started at all — either this
    /// instance is already mid-run, or another `LoopEngineRunner`
    /// instance is already running against the same `gitRoot`. Callers
    /// (e.g. the chat command and the Auto Task scheduler) must check
    /// for `nil` rather than assume every call produced a real status,
    /// since a `nil` return means nothing was logged or attempted.
    /// Otherwise returns the final `LoopEngineStatus` (also available
    /// afterwards via `status`).
    ///
    /// - Parameters:
    ///   - faultsRoot: project root passed through to the regression sweep.
    ///   - gitRoot: git working tree shell-command stages run in,
    ///     approvals are keyed against, and the concurrency lock key.
    @discardableResult
    func run(config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL) async -> LoopEngineStatus? {
        guard !running else { return nil }
        let rootKey = gitRoot.standardizedFileURL.path
        guard !Self.activeRoots.contains(rootKey) else { return nil }
        Self.activeRoots.insert(rootKey)
        running = true
        status = nil
        iteration = 0
        defer {
            running = false
            Self.activeRoots.remove(rootKey)
        }

        let orderedStages = config.stages.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
        appendLog(.info, "Loop started · \(orderedStages.count) stage(s), max \(config.maxIterations) iteration(s)")

        // Preflight: every shell-command stage's approval is checked BEFORE
        // any iteration runs — burning iterations/LLM repair calls on an
        // earlier stage only to discover a LATER stage is unapproved would
        // waste both, and per spec, needing approval must not itself
        // consume an iteration.
        for stage in orderedStages where stage.kind == .shellCommand {
            guard let command = Self.validCommand(stage) else {
                let rejected = LoopEngineStatus.error("Stage \"\(stage.name)\" has no command")
                status = rejected
                appendLog(.error, "Loop finished · \(describe(rejected))")
                return rejected
            }
            guard approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) else {
                let rejected = LoopEngineStatus.needsApproval(stageName: stage.name)
                status = rejected
                appendLog(.error, "Loop finished · \(describe(rejected))")
                return rejected
            }
        }

        // Per-stage consecutive-identical-failure tracking, keyed by stage
        // id. Deliberately NOT a single shared hash/count: stage A failing,
        // getting repaired, and passing must not contaminate stage B's own
        // count just because B later fails with a coincidentally similar
        // (or, pre-normalization, identically-shaped) hash.
        var failureState: [String: (hash: String, count: Int)] = [:]

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
                    // Preflight already validated this once per stage; if a
                    // command somehow becomes invalid by the time we get
                    // here, fail closed instead of force-unwrapping.
                    guard let command = Self.validCommand(stage) else {
                        status = .error("Stage \"\(stage.name)\" has no command")
                        break iterationLoop
                    }

                    let outcome: VerifyOutcome
                    do {
                        outcome = try await verifier.verify(command: command, repoRoot: gitRoot, timeout: stageTimeout)
                    } catch is CancellationError {
                        status = .aborted
                        break iterationLoop
                    } catch VerifyError.timedOut(let seconds) {
                        // A timeout means the stage never confirmed passing —
                        // treat it like an ordinary non-zero-exit failure (same
                        // hash/retry/repair path below), not a fatal run-ending
                        // error. Only a genuine launch failure below is fatal.
                        outcome = VerifyOutcome(exitCode: -1, output: "stage timed out after \(seconds)s")
                    } catch {
                        status = .error(error.localizedDescription)
                        appendLog(.error, "  [\(stage.name)] error: \(error.localizedDescription)")
                        break iterationLoop
                    }

                    if outcome.exitCode == 0 {
                        appendLog(.info, "  [\(stage.name)] passed")
                        failureState[stage.id] = nil
                    } else {
                        let excerpt = String(outcome.output.suffix(500))
                        appendLog(.warn, "  [\(stage.name)] FAILED (exit \(outcome.exitCode)): \(excerpt)")
                        let hash = Self.hash(outcome.output)
                        let count: Int
                        if let previous = failureState[stage.id], previous.hash == hash {
                            count = previous.count + 1
                        } else {
                            count = 1
                        }
                        failureState[stage.id] = (hash: hash, count: count)
                        if count >= config.consecutiveFailureStop {
                            status = .givenUp(reason: .repeatedFailure)
                            break iterationLoop
                        }
                        if iteration >= config.maxIterations {
                            status = .givenUp(reason: .maxIterations)
                            break iterationLoop
                        }
                        appendLog(.info, "  [\(stage.name)] repairing…")
                        do {
                            try await stageRepairer.repair(
                                stageName: stage.name, command: command,
                                failureOutput: outcome.output, repoRoot: gitRoot)
                        } catch {
                            status = .error(error.localizedDescription)
                            appendLog(.error, "  [\(stage.name)] repair error: \(error.localizedDescription)")
                            break iterationLoop
                        }
                        continue iterationLoop
                    }
                }
            }

            if status == nil {
                status = .success
                break iterationLoop
            }
        }

        let finalStatus = status ?? .givenUp(reason: .maxIterations)
        status = finalStatus
        appendLog(logLevel(for: finalStatus), "Loop finished · \(describe(finalStatus))")
        return finalStatus
    }

    private func appendLog(_ level: LogLine.Level, _ text: String) {
        log.append(LogLine(at: Date(), level: level, text: text))
    }

    /// Returns the stage's command when non-nil and non-blank; nil
    /// otherwise. A missing/empty command is a config error, distinct
    /// from a stage that ran and failed.
    private static func validCommand(_ stage: LoopStage) -> String? {
        guard let command = stage.command,
              !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return command
    }

    /// Hashes failure output after stripping digit runs, so elapsed-time
    /// noise (e.g. `swift test`'s `"Executed 5 tests ... in 0.003 (0.005)
    /// seconds"`, or PIDs/timestamps in other tools' output) doesn't make
    /// an otherwise-identical failure register as "new" every iteration
    /// and silently defeat `consecutiveFailureStop`. Not a perfect
    /// normalization — just enough to neutralize the most common source
    /// of false negatives.
    private static func hash(_ s: String) -> String {
        let normalized = s.replacingOccurrences(of: #"[0-9]+"#, with: "#", options: .regularExpression)
        let digest = SHA256.hash(data: Data(normalized.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func logLevel(for status: LoopEngineStatus) -> LogLine.Level {
        if case .success = status { return .info }
        return .error
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
