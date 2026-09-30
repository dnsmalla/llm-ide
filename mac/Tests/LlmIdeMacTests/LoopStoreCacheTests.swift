import XCTest
@testable import LlmIdeMacLib

final class LoopStoreCacheTests: XCTestCase {
    private var root: URL!
    private var repo: URL!
    private var defaults: UserDefaults!
    private let pid = "proj-cache"

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-cache-\(UUID().uuidString)", isDirectory: true)
        root = base.appendingPathComponent("proj", isDirectory: true)
        repo = base.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try Data("// swift-tools-version:5.9\n".utf8).write(to: repo.appendingPathComponent("Package.swift"))
        let name = "loop-cache-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { [d = defaults!] in d.removePersistentDomain(forName: name) }
        LoopStoreCache.shared.invalidateAll()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }

    private func loops() -> LoopEngineProjectStore {
        LoopEngineConfigStore.loops(projectRoot: root, projectId: pid, gitRoot: repo, defaults: defaults)
    }

    private func mutate(_ body: (inout LoopEngineProjectStore) -> Void) {
        var s = loops()
        body(&s)
        LoopEngineConfigStore.save(s, projectRoot: root, projectId: pid, defaults: defaults)
    }

    func testCacheReturnsSameResultAndSeesOwnWrites() {
        let first = loops()
        XCTAssertEqual(loops(), first)
        mutate { $0.loops[0].name = "Renamed" }
        XCTAssertEqual(loops().loops[0].name, "Renamed")
    }

    func testExternalFileChangeIsPickedUp() throws {
        mutate { $0.loops[0].name = "Mine" }
        _ = loops()
        var external = loops()
        external.loops[0].name = "FromGitPull"
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(external).write(to: LoopEngineConfigStore.fileURL(projectRoot: root))
        XCTAssertEqual(loops().loops[0].name, "FromGitPull")
    }

    func testSweepRecheckSkipsGoneUnscheduledAndEmptyLoops() {
        mutate { $0.loops[0].runsOnSchedule = true }
        let target = loops().loops[0]
        func recheck(_ l: LoopDefinition) -> (loop: LoopDefinition?, skipReason: String?) {
            LoopEngineConfigStore.sweepRecheck(l, projectRoot: root, projectId: pid, gitRoot: repo, defaults: defaults)
        }
        XCTAssertNotNil(recheck(target).loop)

        var ghost = target; ghost.id = "nope"
        XCTAssertEqual(recheck(ghost).skipReason, "it no longer exists")

        mutate { $0.loops[0].runsOnSchedule = false }
        XCTAssertEqual(recheck(target).skipReason, "it is no longer scheduled")

        mutate { s in
            s.loops[0].runsOnSchedule = true
            s.loops[0].config.stages = s.loops[0].config.stages.map { var x = $0; x.enabled = false; return x }
        }
        XCTAssertNotNil(recheck(target).skipReason)
    }
}
