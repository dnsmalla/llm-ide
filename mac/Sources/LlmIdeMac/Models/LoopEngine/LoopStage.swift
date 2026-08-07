import Foundation

/// One step of a Loop Engineering run. `.regressionSweep` re-runs the
/// existing `RegressionRunner` sweep (no shell command of its own);
/// `.shellCommand` runs an arbitrary project command (e.g. "swift test")
/// via `ShellFaultVerifier`, gated by `VerifyApprovalStore` like a fault
/// verify command.
struct LoopStage: Identifiable, Codable, Equatable {
    enum Kind: String, Codable {
        case regressionSweep
        case shellCommand
    }

    var id: String = UUID().uuidString
    var name: String
    var kind: Kind
    /// nil for `.regressionSweep`; required for `.shellCommand`.
    var command: String?
    var order: Int
}
