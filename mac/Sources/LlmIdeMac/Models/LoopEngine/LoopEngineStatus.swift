import Foundation

enum LoopEngineStatus: Equatable {
    enum GivenUpReason: Equatable {
        case maxIterations
        case repeatedFailure
        case regressionStalled
        /// A blocking stage kept failing without its failure count shrinking.
        /// Distinct from `.repeatedFailure` (byte-identical failures): the
        /// failures here were *different* each time but no better, which is the
        /// thrashing case a hash comparison cannot see.
        case noProgress(stageName: String)
        /// `LoopEngineConfig.wallClockBudgetSeconds` elapsed.
        case wallClockExceeded
        /// `LoopEngineConfig.maxRepairsPerStage` reached for one stage.
        case repairBudgetExhausted(stageName: String)
    }

    /// Why a run was stopped for safety rather than given up on for lack of
    /// progress. Kept separate from `GivenUpReason` because the operator
    /// response differs: a give-up means "the agent could not fix it", a block
    /// means "the agent tried something it is not allowed to do".
    enum BlockedReason: Equatable {
        /// A repair edited a protected path — a test, a build file, or the
        /// harness's own state — or a path outside the loop's optional scope
        /// allowlist. See `RepairScopeGuard` and `LoopEngineRunner.withScopeGuard`.
        /// The two triggers share one case because the runner merges both
        /// violation sets before reporting: `paths` never says which rule a
        /// given entry broke.
        case repairOutOfScope(stageName: String, paths: [String])
    }

    case success
    case givenUp(reason: GivenUpReason)
    case blocked(reason: BlockedReason)
    case needsApproval(stageName: String)
    case error(String)
    case aborted
}

extension LoopEngineStatus {
    /// One-line human-readable summary. Single source of truth for every
    /// caller that needs to describe a terminal status (logs, activity
    /// feed, task errors) so they can never drift into reporting different
    /// detail for the same run — see the Task 9 review that caught
    /// `AutoCodeUpdateService`'s own lossier copy of this switch.
    var summary: String {
        switch self {
        case .success: return "success"
        case .givenUp(.maxIterations): return "given up (max iterations)"
        case .givenUp(.repeatedFailure): return "given up (repeated failure)"
        case .givenUp(.regressionStalled): return "given up (regressions stopped shrinking)"
        case .givenUp(.noProgress(let name)): return "given up (\"\(name)\" stopped improving)"
        case .givenUp(.wallClockExceeded): return "given up (time budget exceeded)"
        case .givenUp(.repairBudgetExhausted(let name)): return "given up (repair budget exhausted for \"\(name)\")"
        case .blocked(.repairOutOfScope(let name, let paths)):
            let list = paths.prefix(3).joined(separator: ", ")
            let more = paths.count > 3 ? " (+\(paths.count - 3) more)" : ""
            return "blocked — repair for \"\(name)\" touched a protected or out-of-scope path(s): \(list)\(more)"
        case .needsApproval(let name): return "needs approval: \(name)"
        case .error(let msg): return "error: \(msg)"
        case .aborted: return "aborted"
        }
    }

    /// Stable machine-readable code, for grouping runs in the journal and any
    /// analysis over it. Deliberately independent of `summary`: that string
    /// carries stage names and path lists, so grouping on it would produce one
    /// bucket per run, and rewording it would silently break historical
    /// comparisons. These codes must not be renamed once written to a journal.
    var code: String {
        switch self {
        case .success: return "success"
        case .givenUp(.maxIterations): return "given_up.max_iterations"
        case .givenUp(.repeatedFailure): return "given_up.repeated_failure"
        case .givenUp(.regressionStalled): return "given_up.regression_stalled"
        case .givenUp(.noProgress): return "given_up.no_progress"
        case .givenUp(.wallClockExceeded): return "given_up.wall_clock"
        case .givenUp(.repairBudgetExhausted): return "given_up.repair_budget"
        case .blocked(.repairOutOfScope): return "blocked.repair_out_of_scope"
        case .needsApproval: return "needs_approval"
        case .error: return "error"
        case .aborted: return "aborted"
        }
    }
}
