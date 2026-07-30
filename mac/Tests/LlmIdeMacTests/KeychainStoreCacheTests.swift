import XCTest
@testable import LlmIdeMacLib

/// Guards the per-session Keychain cache introduced in
/// `fix(mac): cache Keychain secrets for the app session`.
///
/// The cache is transparent — a cache hit and a real keychain read return the
/// same value, by design — so these tests pin the *contract* the cache must not
/// break: save/load/update/delete correctness, no stale value after delete
/// (negative cache), and recovery when a value is re-saved after deletion.
///
/// Each test uses a throwaway host so it neither collides with real tokens nor
/// leaves anything behind in the keychain (`tearDown` deletes the account from
/// both the keychain and the in-memory cache).
final class KeychainStoreCacheTests: XCTestCase {
    private var host: String!

    override func setUp() {
        super.setUp()
        host = "keychain-test-\(UUID().uuidString).local"
    }

    override func tearDown() {
        // Removes the test account from both the keychain and the session cache.
        KeychainStore.deleteGitLabToken(host: host)
        super.tearDown()
    }

    func testSaveLoadUpdateDeleteRoundTrip() {
        // Miss before first save — recorded so repeated reads don't re-hit keychain.
        XCTAssertNil(KeychainStore.loadGitLabToken(host: host))

        KeychainStore.saveGitLabToken("alpha", host: host)
        XCTAssertEqual(KeychainStore.loadGitLabToken(host: host), "alpha")

        // Overwrite must update the cached value, not leave the first one stuck.
        KeychainStore.saveGitLabToken("beta", host: host)
        XCTAssertEqual(KeychainStore.loadGitLabToken(host: host), "beta")

        // Delete invalidates the cache; subsequent reads return nil (no stale leak).
        KeychainStore.deleteGitLabToken(host: host)
        XCTAssertNil(KeychainStore.loadGitLabToken(host: host))
    }

    func testResaveAfterDeleteClearsNegativeCache() {
        KeychainStore.saveGitLabToken("first", host: host)
        KeychainStore.deleteGitLabToken(host: host)
        XCTAssertNil(KeychainStore.loadGitLabToken(host: host))

        // A fresh save must clear the recorded miss and serve the new value.
        KeychainStore.saveGitLabToken("second", host: host)
        XCTAssertEqual(KeychainStore.loadGitLabToken(host: host), "second")
    }
}
