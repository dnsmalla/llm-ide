import Foundation
import Security
import os.log

/// Secret storage. All tokens (JWT refresh, GitLab PAT, GitHub PAT) live in a
/// SINGLE keychain item — a JSON map keyed by account. One item means at most
/// one macOS "…wants to use the keychain" password prompt per launch, instead
/// of one-per-secret (3) when each lived in its own item.
///
/// The public per-secret API (saveToken/loadToken/…) is unchanged; callers
/// still address secrets by host. Internally each call reads/writes the
/// in-memory map and persists the whole map to the one item.
enum KeychainStore {
    private static let service = "com.llmide.macapp"
    /// Pre-rename service id. Read-only fallback so users upgrading from the
    /// MeetNotes build keep their saved tokens; migrated into the blob once.
    private static let legacyService = "com.meetnotes.macapp"
    /// The single keychain account that holds every secret as a JSON map.
    private static let blobAccount = "llmide::secrets::v1"
    /// Sentinel stored in the blob so the one-time migration of the old
    /// per-secret items runs exactly once, not every launch.
    private static let migratedKey = "__migrated_to_blob__"
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "Keychain")

    /// In-memory mirror of the single keychain item. Loaded once per process
    /// (one keychain read ⇒ at most one prompt); served from RAM after that.
    private static var blob: [String: String] = [:]
    private static var blobLoaded = false
    private static let lock = NSLock()

    // MARK: - Blob load / persist

    /// Load the single secrets item into memory. Idempotent — does nothing
    /// after the first load. Does NOT migrate; see `migrateIfNeeded`.
    private static func ensureBlobLoaded() {
        lock.lock()
        if blobLoaded { lock.unlock(); return }
        if let data = readRaw(account: blobAccount, service: service),
           let parsed = try? JSONDecoder().decode([String: String].self, from: data) {
            blob = parsed
        } else {
            blob = [:]
        }
        blobLoaded = true
        lock.unlock()
    }

    /// Persist the in-memory map to the single keychain item. Caller holds `lock`.
    private static func persistBlobLocked() {
        if blob[migratedKey] == nil { blob[migratedKey] = "1" }
        guard let data = try? JSONEncoder().encode(blob) else { return }
        writeRaw(account: blobAccount, service: service, data: data)
    }

    /// One-time forward migration: copy the legacy per-secret items (refresh,
    /// GitLab, GitHub — and the pre-rename com.meetnotes service) into the
    /// single blob, then delete the old items. Reading an existing old item
    /// prompts once (the LAST prompts a user with saved tokens will see);
    /// missing items return silently, so fresh installs migrate with zero
    /// prompts. Guarded by the `migratedKey` sentinel so it runs only once.
    private static func migrateIfNeeded(refreshHost: String, gitLabHost: String) {
        ensureBlobLoaded()
        lock.lock()
        if blob[migratedKey] != nil { lock.unlock(); return }
        let accounts = [
            "\(refreshHost)::refresh_token",
            "gitlab::\(gitLabHost)::token",
            "github::github.com::token",
        ]
        // Copy each legacy item into the blob, remembering which ones we
        // actually read — we only delete an old item we successfully copied,
        // never one we failed to read (e.g. the user dismissed the auth
        // prompt). An unread token stays in its old item rather than being
        // silently destroyed.
        var copied: [String] = []
        for account in accounts where blob[account] == nil {
            if let v = loadLegacy(account: account) { blob[account] = v; copied.append(account) }
        }
        persistBlobLocked()
        lock.unlock()
        for account in copied {
            deleteRaw(account: account, service: service)
            deleteRaw(account: account, service: legacyService)
        }
    }

    // MARK: - Session warm-up

    /// Prefetch the secrets this process needs so keychain UI appears at most
    /// once per launch — a single read of the blob item — not on every
    /// Settings refresh or API call.
    static func warmSessionCache(refreshTokenHost: String, gitLabHost: String) {
        ensureBlobLoaded()
        migrateIfNeeded(refreshHost: refreshTokenHost, gitLabHost: gitLabHost)
        // MobilePin keeps its own item (pairing PIN); not part of the token trio.
    }

    private static func clearBlobCache() {
        lock.lock()
        blob.removeAll(keepingCapacity: false)
        blobLoaded = false
        lock.unlock()
        MobilePin.clearSessionCache()
    }

    // MARK: - JWT refresh token

    static func saveToken(_ token: String, host: String) {
        set("\(host)::refresh_token", token)
    }

    static func loadToken(host: String) -> String? {
        ensureBlobLoaded()
        return get("\(host)::refresh_token")
    }

    static func deleteToken(host: String) {
        remove("\(host)::refresh_token")
    }

    // MARK: - GitLab PAT

    static func saveGitLabToken(_ token: String, host: String) {
        set("gitlab::\(host)::token", token)
    }

    static func loadGitLabToken(host: String) -> String? {
        ensureBlobLoaded()
        return get("gitlab::\(host)::token")
    }

    static func deleteGitLabToken(host: String) {
        remove("gitlab::\(host)::token")
    }

    // MARK: - GitHub PAT
    //
    // GitHub doesn't have a per-host concept the way self-hosted GitLab
    // does (this v1 targets github.com only), but we keep the same shape
    // so we can extend later for GitHub Enterprise.

    static func saveGitHubToken(_ token: String, host: String = "github.com") {
        set("github::\(host)::token", token)
    }

    static func loadGitHubToken(host: String = "github.com") -> String? {
        ensureBlobLoaded()
        return get("github::\(host)::token")
    }

    static func deleteGitHubToken(host: String = "github.com") {
        remove("github::\(host)::token")
    }

    // MARK: - Bulk wipe

    /// Removes every Keychain item this app has stored (the secrets blob plus
    /// any pre-blob per-secret stragglers) by deleting all generic-password
    /// entries with our service identifier, then clears the saved-projects
    /// lists so repo metadata can't outlive the tokens that authorized them.
    @MainActor
    static func logout() {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            log.error("KeychainStore.logout failed: OSStatus \(status, privacy: .public)")
        }
        // Also wipe items from the pre-rename MeetNotes service.
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: legacyService,
        ] as CFDictionary)
        clearBlobCache()
        AppConfig.shared.gitLabSavedProjects = []
        AppConfig.shared.gitHubSavedRepos = []
    }

    // MARK: - Map accessors (backed by the single blob item)

    private static func get(_ account: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return blob[account]
    }

    private static func set(_ account: String, _ value: String) {
        lock.lock()
        blob[account] = value
        persistBlobLocked()
        lock.unlock()
    }

    private static func remove(_ account: String) {
        lock.lock()
        blob.removeValue(forKey: account)
        persistBlobLocked()
        lock.unlock()
    }

    /// Read a legacy per-secret item from either the current or the
    /// pre-rename service. Used only by the one-time migration.
    private static func loadLegacy(account: String) -> String? {
        if let d = readRaw(account: account, service: service),
           let s = String(data: d, encoding: .utf8) { return s }
        if let d = readRaw(account: account, service: legacyService),
           let s = String(data: d, encoding: .utf8) { return s }
        return nil
    }

    // MARK: - Raw keychain primitives

    private static func readRaw(account: String, service: String) -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return data
    }

    @discardableResult
    private static func writeRaw(account: String, service: String, data: Data) -> Bool {
        let match: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        // Update-in-place first, add only if absent — never empties the item.
        let updateStatus = SecItemUpdate(match as CFDictionary,
                                         [kSecValueData: data] as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        if updateStatus == errSecItemNotFound {
            var addQuery = match
            addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            addQuery[kSecValueData] = data
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            if addStatus != errSecSuccess {
                log.error("KeychainStore.writeRaw (add) failed: OSStatus \(addStatus, privacy: .public)")
            }
            return addStatus == errSecSuccess
        }
        log.error("KeychainStore.writeRaw (update) failed: OSStatus \(updateStatus, privacy: .public)")
        return false
    }

    private static func deleteRaw(account: String, service: String) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
