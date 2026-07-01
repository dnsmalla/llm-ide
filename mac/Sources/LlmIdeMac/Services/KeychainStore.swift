import Foundation
import Security
import os.log

enum KeychainStore {
    private static let service = "com.llmide.macapp"
    /// Pre-rename service id. Read-only fallback so users upgrading from the
    /// MeetNotes build keep their saved tokens; items are migrated forward on
    /// first read.
    private static let legacyService = "com.meetnotes.macapp"
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "Keychain")

    // MARK: - JWT refresh token (existing pattern placeholder)

    static func saveToken(_ token: String, host: String) {
        save(token, account: "\(host)::refresh_token")
    }

    static func loadToken(host: String) -> String? {
        load(account: "\(host)::refresh_token")
    }

    static func deleteToken(host: String) {
        delete(account: "\(host)::refresh_token")
    }

    // MARK: - GitLab PAT

    static func saveGitLabToken(_ token: String, host: String) {
        save(token, account: "gitlab::\(host)::token")
    }

    static func loadGitLabToken(host: String) -> String? {
        load(account: "gitlab::\(host)::token")
    }

    static func deleteGitLabToken(host: String) {
        delete(account: "gitlab::\(host)::token")
    }

    // MARK: - GitHub PAT
    //
    // GitHub doesn't have a per-host concept the way self-hosted GitLab
    // does (this v1 targets github.com only), but we keep the same shape
    // so we can extend later for GitHub Enterprise.

    static func saveGitHubToken(_ token: String, host: String = "github.com") {
        save(token, account: "github::\(host)::token")
    }

    static func loadGitHubToken(host: String = "github.com") -> String? {
        load(account: "github::\(host)::token")
    }

    static func deleteGitHubToken(host: String = "github.com") {
        delete(account: "github::\(host)::token")
    }

    // MARK: - Bulk wipe

    /// Removes every Keychain item this app has stored (refresh tokens,
    /// GitLab PATs, etc.) by deleting all generic-password entries with
    /// our service identifier. Also clears the app's GitLab project list
    /// in `AppConfig` so saved-project metadata can't outlive the tokens
    /// that authorized them.
    @MainActor
    static func logout() {
        // Nuke all generic-password items keyed to our service. This is
        // host-agnostic so we don't leave dangling tokens if the user
        // switched gitLabBaseURL between save and logout.
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            log.error("KeychainStore.logout failed: OSStatus \(status, privacy: .public)")
        }
        // Wipe the saved-projects list so the next user of this Mac
        // can't see what repos the previous user had connected.
        AppConfig.shared.gitLabSavedProjects = []
        AppConfig.shared.gitHubSavedRepos = []
    }

    // MARK: - Primitives

    @discardableResult
    private static func save(_ value: String, account: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        // Update-in-place first, add only if absent. The old delete-then-add
        // had a window where a failed SecItemAdd left the account with NO
        // token (silent credential loss); update/add never empties it.
        let match: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        let updateStatus = SecItemUpdate(match as CFDictionary,
                                         [kSecValueData: data] as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        if updateStatus == errSecItemNotFound {
            var addQuery = match
            addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            addQuery[kSecValueData] = data
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            if addStatus != errSecSuccess {
                log.error("KeychainStore.save (add) failed: OSStatus \(addStatus, privacy: .public)")
            }
            return addStatus == errSecSuccess
        }
        log.error("KeychainStore.save (update) failed: OSStatus \(updateStatus, privacy: .public)")
        return false
    }

    private static func load(account: String) -> String? {
        if let v = load(account: account, service: service) { return v }
        // Fallback: migrate a value stored under the old MeetNotes service id.
        if let legacy = load(account: account, service: legacyService) {
            save(legacy, account: account)   // copy forward under the new id
            return legacy
        }
        return nil
    }

    private static func load(account: String, service: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(account: String) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
