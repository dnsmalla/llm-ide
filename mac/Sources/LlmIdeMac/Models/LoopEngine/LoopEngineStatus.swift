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
