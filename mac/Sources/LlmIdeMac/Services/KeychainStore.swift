import Foundation
import Security
import os.log

/// Outcome of a raw keychain read. "Nothing stored" and "could not read what
/// is stored" are different facts and must never be conflated — only the
/// former makes it safe to write over the item.
enum KeychainRawRead: Equatable {
    case found(Data)
    case notFound
    case failed(OSStatus)
}

/// Raw keychain I/O. Injectable so tests can simulate a denied or locked
/// keychain — the condition that used to be mistaken for "empty" and then
/// overwritten, destroying every stored secret.
protocol RawKeychainAccess: Sendable {
    func read(account: String, service: String) -> KeychainRawRead
    func write(account: String, service: String, data: Data) -> Bool
    func delete(account: String, service: String)
    @discardableResult func deleteAll(service: String) -> OSStatus
}

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
    /// True when the last load attempt hit a real keychain FAILURE (denied,
    /// locked, corrupt payload) as opposed to "no item stored yet".
    ///
    /// This distinction is the whole point of `KeychainRawRead`. The old code funnelled
    /// both cases into `nil` ⇒ `blob = [:]` ⇒ `blobLoaded = true`, so the very
    /// next write persisted that empty map over the real item and destroyed
    /// every stored secret — the refresh token included, which is why a saved
    /// login stopped surviving relaunch. While this flag is set we refuse to
    /// persist and we do NOT latch `blobLoaded`, so the next call retries the
    /// read instead of serving a phantom empty map for the whole session.
    private static var loadFailed = false
    /// Last keychain OSStatus worth reporting, for diagnostics/UI. nil = healthy.
    private(set) static var lastFailureStatus: OSStatus?
    private static let lock = NSLock()

    /// Raw keychain access. Production uses `SecItem*`; tests substitute a
    /// fake to exercise the read-failure paths.
    internal static var backend: RawKeychainAccess = SecItemKeychainAccess()

    /// True when secrets are readable (or legitimately absent). False after a
    /// failed load, when writes are blocked to protect the stored data.
    ///
    /// Performs a load if one hasn't succeeded yet, so the answer is accurate
    /// — which also means it can hit the keychain (and re-prompt) after a
    /// failure. Call it from logic that must be right, not from a SwiftUI
    /// body; views want `lastKnownHealthy`.
    static var isHealthy: Bool {
        lock.lock(); defer { lock.unlock() }
        ensureBlobLoadedLocked()
        return !loadFailed
    }

    /// Last observed health, with no keychain I/O — safe to read from a view
    /// body that may re-render many times. Optimistic before the first load:
    /// nothing has failed yet.
    static var lastKnownHealthy: Bool {
        lock.lock(); defer { lock.unlock() }
        return !loadFailed
    }

    // MARK: - Blob load / persist

    /// Load the single secrets item into memory. Idempotent once a load has
    /// SUCCEEDED; a failed load is retried on the next call. Caller holds
    /// `lock`. Does NOT migrate; see `migrateIfNeeded`.
    private static func ensureBlobLoadedLocked() {
        if blobLoaded { return }
        switch readRaw(account: blobAccount, service: service) {
        case .found(let data):
            if let parsed = try? JSONDecoder().decode([String: String].self, from: data) {
                blob = parsed
                blobLoaded = true
                loadFailed = false
                lastFailureStatus = nil
            } else {
                // The item exists but we can't parse it. Treating that as
                // "empty" would overwrite recoverable data on the next write,
                // so refuse to persist and keep the bytes intact for recovery.
                blob = [:]
                loadFailed = true
                lastFailureStatus = errSecDecode
                log.error("Secrets blob is present but undecodable — writes blocked to preserve it")
            }
        case .notFound:
            blob = [:]
            blobLoaded = true
            loadFailed = false
            lastFailureStatus = nil
        case .failed(let status):
            // Deliberately leave `blobLoaded == false` so a later call retries
            // (e.g. once the keychain is unlocked or the user allows access).
            blob = [:]
            loadFailed = true
            lastFailureStatus = status
            log.error("Keychain read failed: OSStatus \(status, privacy: .public) — secrets unavailable, writes blocked this attempt")
        }
    }

    /// Persist the in-memory map to the single keychain item. Caller holds `lock`.
    /// Returns false when the write was refused or failed.
    @discardableResult
    private static func persistBlobLocked() -> Bool {
        guard !loadFailed else {
            log.error("Refusing to persist secrets: the last keychain load failed, so writing the in-memory map would destroy the stored secrets")
            return false
        }
        if blob[migratedKey] == nil { blob[migratedKey] = "1" }
        guard let data = try? JSONEncoder().encode(blob) else { return false }
        let ok = writeRaw(account: blobAccount, service: service, data: data)
        if !ok { lastFailureStatus = errSecIO }
        return ok
    }

    /// One-time forward migration: copy the legacy per-secret items (refresh,
    /// GitLab, GitHub — and the pre-rename com.meetnotes service) into the
    /// single blob, then delete the old items. Reading an existing old item
    /// prompts once (the LAST prompts a user with saved tokens will see);
    /// missing items return silently, so fresh installs migrate with zero
    /// prompts. Guarded by the `migratedKey` sentinel so it runs only once.
    private static func migrateIfNeeded(refreshHost: String, gitLabHost: String) {
        lock.lock()
        ensureBlobLoadedLocked()
        // A failed load must not run the migration: `blob` is empty only
        // because we couldn't read it, so persisting would both clobber the
        // real secrets and stamp the `migratedKey` sentinel, permanently
        // marking a migration that never happened.
        if loadFailed { lock.unlock(); return }
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
        migrateIfNeeded(refreshHost: refreshTokenHost, gitLabHost: gitLabHost)
        // Mobile Control keeps its own pairing-PIN item, separate from the
        // blob above, but still warmed here so its keychain read also happens
        // in this single launch-time pass instead of lazily on first mobile-
        // control use — which would otherwise cost a second unlock prompt.
        // No-op when Mobile Control is compiled out.
        FeatureCatalog.warmMobilePinCache()
    }

    /// Drop the in-memory mirror after a wipe attempt.
    ///
    /// `wiped` says whether the backing item is genuinely gone. On success we
    /// record a KNOWN-empty load so a later write may legitimately re-create
    /// the item. On failure the old item is still out there holding real
    /// secrets, so we force a re-read instead — marking it known-empty would
    /// let the next write clobber whatever survived, which is the same bug
    /// this file exists to prevent.
    private static func clearBlobCache(wiped: Bool) {
        lock.lock()
        blob.removeAll(keepingCapacity: false)
        blobLoaded = wiped
        loadFailed = false
        lastFailureStatus = nil
        lock.unlock()
        FeatureCatalog.clearMobilePinSessionCache()
    }

    // MARK: - JWT refresh token

    static func saveToken(_ token: String, host: String) {
        set("\(host)::refresh_token", token)
    }

    static func loadToken(host: String) -> String? {
        get("\(host)::refresh_token")
    }

    static func deleteToken(host: String) {
        remove("\(host)::refresh_token")
    }

    // MARK: - GitLab PAT

    static func saveGitLabToken(_ token: String, host: String) {
        set("gitlab::\(host)::token", token)
    }

    static func loadGitLabToken(host: String) -> String? {
        get("gitlab::\(host)::token")
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
        get("github::\(host)::token")
    }

    static func deleteGitHubToken(host: String = "github.com") {
        remove("github::\(host)::token")
    }

    // MARK: - Bulk wipe

    /// Removes every Keychain item this app has stored (the secrets blob plus
    /// any pre-blob per-secret stragglers) by deleting all generic-password
    /// entries with our service identifier, then clears the saved-projects
    /// lists so repo metadata can't outlive the tokens that authorized them.
    ///
    /// This is the "disconnect everything" action and takes the mobile pairing
    /// PIN with it. It is deliberately NOT what plain sign-out calls: signing
    /// out of the LLM-IDE account is about the server session, and revoking
    /// the user's GitHub/GitLab PATs plus their saved repo list as a side
    /// effect meant reopening the app showed "No repository connected" with
    /// no way back except re-entering every credential.
    @MainActor
    static func wipeAllSecrets() {
        let status = backend.deleteAll(service: service)
        let wiped = (status == errSecSuccess || status == errSecItemNotFound)
        if !wiped {
            log.error("KeychainStore.wipeAllSecrets failed: OSStatus \(status, privacy: .public)")
        }
        // Also wipe items from the pre-rename MeetNotes service.
        backend.deleteAll(service: legacyService)
        clearBlobCache(wiped: wiped)
        AppConfig.shared.gitLabSavedProjects = []
        AppConfig.shared.gitHubSavedRepos = []
    }

    // MARK: - Map accessors (backed by the single blob item)

    private static func get(_ account: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        ensureBlobLoadedLocked()
        return blob[account]
    }

    /// Write one secret. Loads the blob first: writing from a never-loaded
    /// (empty) map would persist a single-entry blob over every other secret.
    /// Returns false when the write was refused or failed.
    @discardableResult
    private static func set(_ account: String, _ value: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        ensureBlobLoadedLocked()
        guard !loadFailed else {
            log.error("Refusing to save secret: keychain is not readable right now")
            return false
        }
        let previous = blob[account]
        blob[account] = value
        if persistBlobLocked() { return true }
        // Keep RAM consistent with disk so a caller that reads back doesn't
        // see a value that was never stored.
        blob[account] = previous
        return false
    }

    @discardableResult
    private static func remove(_ account: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        ensureBlobLoadedLocked()
        guard !loadFailed else {
            log.error("Refusing to delete secret: keychain is not readable right now")
            return false
        }
        // Nothing stored ⇒ nothing to do. Skipping the write also stops a
        // no-op delete from re-creating an item that `logout()` just removed.
        guard let previous = blob[account] else { return true }
        blob.removeValue(forKey: account)
        if persistBlobLocked() { return true }
        blob[account] = previous
        return false
    }

    /// Read a legacy per-secret item from either the current or the
    /// pre-rename service. Used only by the one-time migration.
    private static func loadLegacy(account: String) -> String? {
        if case .found(let d) = readRaw(account: account, service: service),
           let s = String(data: d, encoding: .utf8) { return s }
        if case .found(let d) = readRaw(account: account, service: legacyService),
           let s = String(data: d, encoding: .utf8) { return s }
        return nil
    }

    // MARK: - Raw keychain primitives

    private static func readRaw(account: String, service: String) -> KeychainRawRead {
        backend.read(account: account, service: service)
    }

    @discardableResult
    private static func writeRaw(account: String, service: String, data: Data) -> Bool {
        backend.write(account: account, service: service, data: data)
    }

    private static func deleteRaw(account: String, service: String) {
        backend.delete(account: account, service: service)
    }

    #if DEBUG
    /// Test-only: drop all in-memory state so the next call re-reads through
    /// whatever `backend` is installed. Not for production use.
    internal static func resetInMemoryStateForTesting() {
        lock.lock()
        blob.removeAll(keepingCapacity: false)
        blobLoaded = false
        loadFailed = false
        lastFailureStatus = nil
        lock.unlock()
    }
    #endif
}

/// The real keychain, via `SecItem*`.
struct SecItemKeychainAccess: RawKeychainAccess {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "Keychain")

    /// Reads one item, keeping "no such item" distinct from "the read failed".
    /// Collapsing the two is what allowed a denied/locked keychain to be
    /// mistaken for an empty one and then overwritten.
    func read(account: String, service: String) -> KeychainRawRead {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { return .failed(errSecDecode) }
            return .found(data)
        case errSecItemNotFound:
            return .notFound
        default:
            // errSecAuthFailed / errSecInteractionNotAllowed / errSecUserCanceled
            // / locked keychain — the item may well exist and be intact.
            return .failed(status)
        }
    }

    func write(account: String, service: String, data: Data) -> Bool {
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
                Self.log.error("Keychain write (add) failed: OSStatus \(addStatus, privacy: .public)")
            }
            return addStatus == errSecSuccess
        }
        Self.log.error("Keychain write (update) failed: OSStatus \(updateStatus, privacy: .public)")
        return false
    }

    func delete(account: String, service: String) {
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ] as CFDictionary)
    }

    @discardableResult
    func deleteAll(service: String) -> OSStatus {
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
        ] as CFDictionary)
    }
}
