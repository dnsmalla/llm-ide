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
    /// keyed by symlink-resolved filesystem path. Guards against two
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
    /// (e.g. the chat command and the Auto Task scheduler) MUST check
    /// for `nil` rather than assume every call produced a real status:
    /// `status` is only meaningful when this returns non-nil — on a
    /// `nil` return, `status` still holds whatever a PREVIOUS run on
    /// this instance left behind (or `nil` if there was none), since a
    /// rejected call doesn't touch it. The rejection is still recorded
    /// to `log`, which is never cleared automatically.
    /// Otherwise returns the final `LoopEngineStatus` (also available
    /// afterwards via `status`).
    ///
    /// - Parameters:
    ///   - faultsRoot: project root passed through to the regression sweep.
    ///   - gitRoot: git working tree shell-command stages run in,
    ///     approvals are keyed against, and the concurrency lock key.
    @discardableResult
    func run(config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL) async -> LoopEngineStatus? {
        guard !running else {
            appendLog(.warn, "Loop not started · this runner instance is already running")
            return nil
        }
        // Resolve symlinks (not just `standardizedFileURL`, which only
        // normalizes path components like "." and ".." — it does NOT
        // resolve symlinks that exist on disk, e.g. a symlinked worktree,
        // or collapse APFS case-insensitivity/firmlink aliasing) so two
        // different-looking paths to the SAME actual directory can't both
        // be admitted as "different" roots and race each other. This only
        // helps for paths that actually exist; two non-existent paths can
        // still alias, but a real `gitRoot` always exists on disk.
        let rootKey = gitRoot.resolvingSymlinksInPath().path
        guard !Self.activeRoots.contains(rootKey) else {
            appendLog(.warn, "Loop not started · a run is already in progress for this repo")
            return nil
        }
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
                appendLog(.error, "Loop finished · \(rejected.summary)")
                return rejected
            }
            guard approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) else {
                appendLog(.warn, "  [\(stage.name)] needs approval: \(command)")
                let rejected = LoopEngineStatus.needsApproval(stageName: stage.name)
                status = rejected
                appendLog(.error, "Loop finished · \(rejected.summary)")
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
            // `RegressionSweepRunning.sweepPassed` is fail-closed and
            // returns `false` on cancellation rather than throwing, so a
            // cancelled regression-sweep-only run would otherwise just
            // burn every remaining iteration as ordinary failures and
            // report `.givenUp(.maxIterations)` — checking here catches
            // that path too, not just the shell-command one below.
            if Task.isCancelled {
                status = .aborted
                break iterationLoop
            }
            iteration += 1
            appendLog(.info, "Iteration \(iteration)/\(config.maxIterations)")

            for stage in orderedStages {
                switch stage.kind {
                case .regressionSweep:
                    let outcome = await regressionSweep.sweep(
                        faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: true)
                    let passed = outcome.passed
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
                        } catch is CancellationError {
                            status = .aborted
                            break iterationLoop
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

        // The `Task.isCancelled` check at the top of the loop only catches
        // cancellation that happens BETWEEN iterations — a give-up path
        // (`.givenUp(.maxIterations)` or `.repeatedFailure`) reached
        // during the FINAL iteration never loops back to that check, so a
        // cancellation that raced with the last iteration would otherwise
        // still report a give-up instead of `.aborted`. Check once more
        // here so cancellation always wins over a give-up verdict.
        if Task.isCancelled, status != .success {
            status = .aborted
        }
        let finalStatus = status ?? .givenUp(reason: .maxIterations)
        status = finalStatus
        appendLog(logLevel(for: finalStatus), "Loop finished · \(finalStatus.summary)")
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

    /// Hashes failure output after stripping duration-shaped and hex
    /// tokens, so elapsed-time noise (e.g. `swift test`'s `"Executed 5
    /// tests ... in 0.003 (0.005) seconds"`) doesn't make an otherwise-
    /// identical failure register as "new" every iteration and silently
    /// defeat `consecutiveFailureStop`.
    ///
    /// Deliberately NOT a blanket "strip every digit" — that would also
    /// erase the failure COUNT itself (`"9 tests, 3 failures"` vs `"9
    /// tests, 1 failure"` is a real, shrinking-toward-fixed difference,
    /// not noise), integer line numbers (`Foo.swift:42` vs `:118`), and
    /// integer assertion values (`("3")` vs `("7")`) — those must keep
    /// hashing differently so genuine progress or a genuinely different
    /// failure is never mistaken for a repeat. Only three narrow,
    /// unambiguously noisy shapes are normalized: decimal durations,
    /// unit-suffixed durations, and hex addresses/ids.
    ///
    /// This is an accepted tradeoff, not a fully solved problem: a
    /// FLOAT or hex assertion value (e.g. `"expected 1.5 got 2.5"` vs
    /// `"expected 1.5 got 9.75"`) still collapses to the same hash,
    /// since these regexes can't distinguish "a duration" from "a float
    /// assertion value" without more context than a bare string offers.
    private static func hash(_ s: String) -> String {
        var normalized = s.replacingOccurrences(
            of: #"\d+\.\d+"#, with: "#", options: .regularExpression)
        normalized = normalized.replacingOccurrences(
            of: #"\b\d+\s*(ms|µs|ns|s|sec|seconds?)\b"#, with: "#", options: .regularExpression)
        normalized = normalized.replacingOccurrences(
            of: #"0x[0-9a-fA-F]+"#, with: "#", options: .regularExpression)
        let digest = SHA256.hash(data: Data(normalized.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func logLevel(for status: LoopEngineStatus) -> LogLine.Level {
        if case .success = status { return .info }
        return .error
    }
}
