import Foundation

enum LoopEngineStatus: Equatable {
    enum GivenUpReason: Equatable {
        case maxIterations
        case repeatedFailure
    }

    case success
    case givenUp(reason: GivenUpReason)
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
        case .needsApproval(let name): return "needs approval: \(name)"
        case .error(let msg): return "error: \(msg)"
        case .aborted: return "aborted"
        }
    }
}
