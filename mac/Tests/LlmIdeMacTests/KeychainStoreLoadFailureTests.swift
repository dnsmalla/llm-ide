import XCTest
@testable import LlmIdeMacLib

/// Guards the fix for the secrets-destroying bug in the single-blob keychain
/// store: `readRaw` used to collapse "no item stored" and "the read failed"
/// into `nil`, so a denied / locked / unreadable keychain was treated as an
/// empty one — and the very next write persisted that empty map over the real
/// item, wiping the JWT refresh token (hence a saved login not surviving
/// relaunch) along with both Git PATs.
///
/// Every test here drives `KeychainStore` through a fake backend so the real
/// keychain is never touched.
final class KeychainStoreLoadFailureTests: XCTestCase {

    /// In-memory keychain whose read outcome is scriptable.
    private final class FakeKeychain: RawKeychainAccess, @unchecked Sendable {
        /// account → stored bytes.
        var items: [String: Data] = [:]
        /// When set, every read returns this failure instead of the stored item.
        var forcedReadFailure: OSStatus?
        /// When true, writes fail (simulates a keychain that denies updates).
        var failWrites = false

        /// When set, `deleteAll` reports this status and leaves items in place.
        var forcedDeleteAllFailure: OSStatus?

        private(set) var writeCount = 0
        private(set) var deleteAllCount = 0

        func read(account: String, service: String) -> KeychainRawRead {
            if let status = forcedReadFailure { return .failed(status) }
            guard let data = items[account] else { return .notFound }
            return .found(data)
        }

        func write(account: String, service: String, data: Data) -> Bool {
            writeCount += 1
            if failWrites { return false }
            items[account] = data
            return true
        }

        func delete(account: String, service: String) { items[account] = nil }

        @discardableResult
        func deleteAll(service: String) -> OSStatus {
            deleteAllCount += 1
            if let status = forcedDeleteAllFailure { return status }
            items.removeAll()
            return errSecSuccess
        }

        /// Decoded view of the single secrets blob, for assertions.
        func blob() -> [String: String] {
            guard let d = items["llmide::secrets::v1"] else { return [:] }
            return (try? JSONDecoder().decode([String: String].self, from: d)) ?? [:]
        }

        /// Seed the blob as if a previous launch had stored these secrets.
        func seedBlob(_ entries: [String: String]) {
            items["llmide::secrets::v1"] = try? JSONEncoder().encode(entries)
        }
    }

    private var fake: FakeKeychain!
    private var realBackend: RawKeychainAccess!

    override func setUp() {
        super.setUp()
        realBackend = KeychainStore.backend
        fake = FakeKeychain()
        KeychainStore.backend = fake
        KeychainStore.resetInMemoryStateForTesting()
    }

    override func tearDown() {
        KeychainStore.backend = realBackend
        KeychainStore.resetInMemoryStateForTesting()
        super.tearDown()
    }

    private static let refreshAccount = "http://127.0.0.1:3456::refresh_token"
    private static let host = "http://127.0.0.1:3456"

    // MARK: - The regression

    /// THE bug: a failed read must never let a later write erase the stored
    /// secrets. Before the fix, `saveGitHubToken` here persisted a map holding
    /// only the GitHub PAT, destroying the refresh token and the GitLab PAT.
    func testFailedReadDoesNotLetLaterWriteDestroyStoredSecrets() {
        fake.seedBlob([
            Self.refreshAccount: "refresh-abc",
            "gitlab::https://gitlab.com::token": "glpat-xyz",
        ])
        fake.forcedReadFailure = errSecAuthFailed

        // Read is denied, so nothing is visible…
        XCTAssertNil(KeychainStore.loadToken(host: Self.host))
        // …and a write must be refused rather than clobbering the item.
        KeychainStore.saveGitHubToken("ghp_new")

        XCTAssertEqual(fake.writeCount, 0, "a write while the keychain is unreadable must be refused")
        XCTAssertEqual(fake.blob()[Self.refreshAccount], "refresh-abc",
                       "the stored refresh token must survive — this is what forced a second login")
        XCTAssertEqual(fake.blob()["gitlab::https://gitlab.com::token"], "glpat-xyz")
    }

    /// A read failure must not be latched for the process lifetime: once the
    /// keychain becomes readable the next call must pick the secrets back up,
    /// so a transient denial doesn't degrade the whole session.
    func testReadIsRetriedAfterATransientFailure() {
        fake.seedBlob([Self.refreshAccount: "refresh-abc"])
        fake.forcedReadFailure = errSecInteractionNotAllowed

        XCTAssertNil(KeychainStore.loadToken(host: Self.host))
        XCTAssertFalse(KeychainStore.isHealthy)

        fake.forcedReadFailure = nil

        XCTAssertEqual(KeychainStore.loadToken(host: Self.host), "refresh-abc")
        XCTAssertTrue(KeychainStore.isHealthy)
    }

    /// An item that exists but can't be decoded is corruption, not absence:
    /// preserve the bytes for recovery instead of overwriting them.
    func testUndecodableBlobIsPreservedNotOverwritten() {
        fake.items["llmide::secrets::v1"] = Data("not json".utf8)

        XCTAssertNil(KeychainStore.loadGitHubToken())
        KeychainStore.saveGitHubToken("ghp_new")

        XCTAssertEqual(fake.writeCount, 0)
        XCTAssertEqual(fake.items["llmide::secrets::v1"], Data("not json".utf8))
    }

    // MARK: - Normal operation still works

    /// "Nothing stored yet" is the one case where writing is safe — a first
    /// run must still be able to create the blob.
    func testFirstRunStoresAndReloadsSecrets() {
        XCTAssertNil(KeychainStore.loadToken(host: Self.host))
        XCTAssertTrue(KeychainStore.isHealthy)

        KeychainStore.saveToken("refresh-1", host: Self.host)
        XCTAssertEqual(fake.blob()[Self.refreshAccount], "refresh-1")

        // Simulate a relaunch: fresh in-memory state, same backing store.
        KeychainStore.resetInMemoryStateForTesting()
        XCTAssertEqual(KeychainStore.loadToken(host: Self.host), "refresh-1",
                       "the saved login must survive a relaunch")
    }

    /// Writing one secret must not disturb the others sharing the blob.
    func testWriteFromColdCachePreservesSiblingSecrets() {
        fake.seedBlob([
            Self.refreshAccount: "refresh-abc",
            "github::github.com::token": "ghp_old",
        ])
        // No read has happened yet in this "process" — the write path must
        // load the blob first rather than persisting from an empty map.
        KeychainStore.saveGitLabToken("glpat-new", host: "https://gitlab.com")

        XCTAssertEqual(fake.blob()[Self.refreshAccount], "refresh-abc")
        XCTAssertEqual(fake.blob()["github::github.com::token"], "ghp_old")
        XCTAssertEqual(fake.blob()["gitlab::https://gitlab.com::token"], "glpat-new")
    }

    /// A rejected write must not leave RAM claiming a value that never landed,
    /// or the app reports a token it will have lost by the next launch.
    func testFailedWriteDoesNotLeaveAPhantomValueInMemory() {
        fake.failWrites = true

        KeychainStore.saveGitHubToken("ghp_never_stored")

        XCTAssertNil(KeychainStore.loadGitHubToken(),
                     "a token whose write failed must not read back as saved")
    }

    /// Deleting an absent key must not re-create the item. Sign-out deletes
    /// the whole item and is immediately followed by `config.gitLabToken = ""`;
    /// that no-op delete used to resurrect the blob.
    func testDeletingAnAbsentKeyDoesNotRecreateTheItem() {
        KeychainStore.deleteGitHubToken()

        XCTAssertEqual(fake.writeCount, 0)
        XCTAssertNil(fake.items["llmide::secrets::v1"])
    }

    /// A sign-out whose wipe FAILED leaves the real secrets on disk. Treating
    /// the cache as known-empty there would let the next write clobber the
    /// survivors, so the store must fall back to re-reading instead.
    @MainActor
    func testFailedLogoutWipeDoesNotLeaveTheCacheClaimingEmpty() {
        fake.seedBlob([Self.refreshAccount: "refresh-abc"])
        fake.forcedDeleteAllFailure = errSecAuthFailed

        KeychainStore.wipeAllSecrets()
        // Next write must re-read first and merge, not overwrite from empty.
        KeychainStore.saveGitHubToken("ghp_new")

        XCTAssertEqual(fake.blob()[Self.refreshAccount], "refresh-abc",
                       "a secret that survived a failed wipe must not be clobbered")
        XCTAssertEqual(fake.blob()["github::github.com::token"], "ghp_new")
    }

    /// Migration stamps a "already migrated" sentinel. It must not run — and
    /// so must not stamp — while the keychain is unreadable, or the legacy
    /// per-secret items would be permanently orphaned.
    func testMigrationIsSkippedWhileTheKeychainIsUnreadable() {
        fake.forcedReadFailure = errSecAuthFailed

        KeychainStore.warmSessionCache(refreshTokenHost: Self.host,
                                       gitLabHost: "https://gitlab.com")

        XCTAssertEqual(fake.writeCount, 0)
        XCTAssertNil(fake.items["llmide::secrets::v1"],
                     "migration must not stamp its sentinel over an unreadable keychain")
    }
}
