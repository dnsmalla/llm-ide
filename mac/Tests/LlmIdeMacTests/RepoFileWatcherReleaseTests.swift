import XCTest
@testable import LlmIdeMacLib

/// The watcher's debounce work item holds `self` weakly, so the last strong
/// reference can be dropped from inside `onChange` — on the watcher's own
/// queue. `deinit` → `stop()` used `queue.sync` unconditionally, which traps
/// (dispatch_sync onto the current queue) in exactly that case.
final class RepoFileWatcherReleaseTests: XCTestCase {
    private final class Holder: @unchecked Sendable {
        var watcher: RepoFileWatcher?
    }

    func testLastReleaseInsideOnChangeDoesNotDeadlock() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("rfw-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let holder = Holder()
        let fired = expectation(description: "onChange fired and released the watcher")
        fired.assertForOverFulfill = false
        holder.watcher = RepoFileWatcher(repoRoot: dir, debounce: 0.1) {
            // Runs on the watcher's queue: dropping the only reference here
            // runs deinit on that same queue.
            holder.watcher = nil
            fired.fulfill()
        }
        XCTAssertNotNil(holder.watcher)

        // FSEvents needs a moment after start before it reports changes.
        Thread.sleep(forTimeInterval: 0.5)
        try "x".write(to: dir.appendingPathComponent("a.swift"), atomically: true, encoding: .utf8)

        wait(for: [fired], timeout: 10)
        XCTAssertNil(holder.watcher)
    }

    func testStopIsIdempotentOffQueue() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("rfw-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let watcher = try XCTUnwrap(RepoFileWatcher(repoRoot: dir) {})
        watcher.stop()
        watcher.stop()
    }
}

/// `BackendManager.resolveLaunchPaths` now applies the same layout check to
/// its fixed candidates (including the bundle-relative guess) as the
/// Desktop/Developer scan, because the chosen dir is executed with node.
final class LaunchPathResolverLayoutTests: XCTestCase {
    func testBareServerMjsIsNotAnLlmIdeServer() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lpr-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        FileManager.default.createFile(atPath: dir.appendingPathComponent("server.mjs").path, contents: Data())

        XCTAssertFalse(LaunchPathResolver.looksLikeLlmIdeServer(dir))

        for sub in ["kb", "routes"] {
            try FileManager.default.createDirectory(
                at: dir.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        FileManager.default.createFile(atPath: dir.appendingPathComponent("kb/db.mjs").path, contents: Data())
        FileManager.default.createFile(atPath: dir.appendingPathComponent("routes/router.mjs").path, contents: Data())

        XCTAssertTrue(LaunchPathResolver.looksLikeLlmIdeServer(dir))
    }
}
