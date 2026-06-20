// Per-MACHINE approve-once gate for verify commands. Approval is keyed
// by sha256(repoPath \0 faultFile \0 command) and stored in UserDefaults
// — deliberately NOT in the fault frontmatter, which travels with the
// repo via git. Local storage means each machine approves a command
// before it ever runs, and any edit to the command text (new hash)
// forces re-approval.

import Foundation
import CryptoKit

final class VerifyApprovalStore {
    private let defaults: UserDefaults
    private static let key = "regressionApprovedVerifyHashes"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func isApproved(repo: URL, faultFile: String, command: String) -> Bool {
        approvedSet().contains(hash(repo: repo, faultFile: faultFile, command: command))
    }

    func approve(repo: URL, faultFile: String, command: String) {
        var set = approvedSet()
        set.insert(hash(repo: repo, faultFile: faultFile, command: command))
        defaults.set(Array(set), forKey: Self.key)
    }

    private func approvedSet() -> Set<String> {
        Set(defaults.stringArray(forKey: Self.key) ?? [])
    }

    private func hash(repo: URL, faultFile: String, command: String) -> String {
        let material = "\(repo.standardizedFileURL.path)\u{0}\(faultFile)\u{0}\(command)"
        let digest = SHA256.hash(data: Data(material.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
