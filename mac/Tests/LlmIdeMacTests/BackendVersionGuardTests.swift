import XCTest
@testable import LlmIdeMacLib

/// The stale-backend guard. `probeHealthDetail` computed `versionTooOld` and
/// nothing ever read it — `probeHealth()` discarded everything but `.ok` — so a
/// `node server.mjs` left running from an older checkout was adopted as
/// healthy and every endpoint added since silently 404'd, with no indication
/// anywhere in the UI. These tests pin the verdict rule and the fact that the
/// verdict now reaches `lastError`.
final class BackendVersionGuardTests: XCTestCase {

    func testAMissingApiVersionCountsAsTooOld() {
        // A server predating the apiVersion field is older than any floor.
        // Inverting this ("unknown means fine") re-blinds the app completely.
        XCTAssertTrue(BackendManager.isVersionTooOld(nil))
    }

    func testVersionBelowTheFloorIsTooOld() {
        XCTAssertTrue(BackendManager.isVersionTooOld(BackendManager.minimumServerApiVersion - 1))
        XCTAssertTrue(BackendManager.isVersionTooOld(0))
    }

    func testFloorAndNewerAreAccepted() {
        XCTAssertFalse(BackendManager.isVersionTooOld(BackendManager.minimumServerApiVersion))
        XCTAssertFalse(BackendManager.isVersionTooOld(BackendManager.minimumServerApiVersion + 4))
    }

    @MainActor
    func testAnAdoptedTooOldServerSurfacesAnActionableError() {
        let mgr = BackendManager()
        XCTAssertFalse(mgr.serverVersionTooOld)
        XCTAssertNil(mgr.lastError)

        mgr.recordServerVersion(
            .init(ok: true, apiVersion: 18, versionTooOld: true), adopted: true)

        XCTAssertTrue(mgr.serverVersionTooOld)
        XCTAssertEqual(mgr.serverApiVersion, 18)
        let err = mgr.lastError ?? ""
        XCTAssertTrue(err.contains("18"), "names the version actually running")
        XCTAssertTrue(err.contains("\(BackendManager.minimumServerApiVersion)"),
                      "names the version required")
        XCTAssertTrue(err.lowercased().contains("restart"), "tells the user what to do")
        XCTAssertTrue(err.contains("adopted"), "explains why an old server is in play")
    }

    @MainActor
    func testACurrentServerRecordsItsVersionAndNoError() {
        let mgr = BackendManager()
        mgr.recordServerVersion(
            .init(ok: true, apiVersion: 24, versionTooOld: false), adopted: false)
        XCTAssertFalse(mgr.serverVersionTooOld)
        XCTAssertEqual(mgr.serverApiVersion, 24)
        XCTAssertNil(mgr.lastError, "a healthy server must not leave a stale banner")
    }

    @MainActor
    func testASpawnedTooOldServerBlamesTheCheckoutNotAdoption() {
        let mgr = BackendManager()
        mgr.recordServerVersion(
            .init(ok: true, apiVersion: 19, versionTooOld: true), adopted: false)
        let err = mgr.lastError ?? ""
        XCTAssertTrue(err.contains("server.mjs"), "points at the configured path")
        XCTAssertFalse(err.contains("adopted"))
    }
}
