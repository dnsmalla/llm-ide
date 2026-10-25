import Foundation
import CryptoKit

/// Skip a scheduled Review Code / Review Doc run when nothing changed since the
/// last successful one. These tasks run the CLI against an isolated worktree of
/// HEAD, so HEAD (plus the task's template, which steers the review) is the
/// whole input; re-reviewing an identical commit just burns tokens.
extension AutoCodeUpdateService {

    nonisolated static let reviewSkipReasonText = "no changes since last review"

    /// A stable fingerprint of what a review would read: the HEAD commit and the
    /// template text. Nil when HEAD can't be read (then never skip).
    nonisolated static func reviewSignature(head: String?, template: String) -> String? {
        guard let head, !head.isEmpty else { return nil }
        let digest = SHA256.hash(data: Data(template.utf8))
        let templateHash = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        return "\(head)|\(templateHash)"
    }

    /// The skip decision. A manual run is an explicit request and never skips;
    /// otherwise skip only when the current signature is known and equals the
    /// one stored after the last successful run.
    nonisolated static func reviewSkipReason(trigger: AutoTaskRunTrigger, previous: String?, current: String?) -> String? {
        guard trigger != .manual, let previous, let current, previous == current else { return nil }
        return reviewSkipReasonText
    }

    nonisolated static func reviewSignatureKey(taskId: String, gitRoot: String) -> String {
        "autotask.reviewSignature.\(taskId).\(gitRoot)"
    }

    nonisolated static func loadReviewSignature(taskId: String, gitRoot: String,
                                                defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: reviewSignatureKey(taskId: taskId, gitRoot: gitRoot))
    }

    nonisolated static func saveReviewSignature(_ signature: String, taskId: String, gitRoot: String,
                                                defaults: UserDefaults = .standard) {
        defaults.set(signature, forKey: reviewSignatureKey(taskId: taskId, gitRoot: gitRoot))
    }
}
