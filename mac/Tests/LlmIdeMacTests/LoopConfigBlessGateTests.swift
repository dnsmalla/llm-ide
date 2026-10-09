import XCTest
@testable import LlmIdeMacLib

/// A UI save of `system/loop.json` during a run re-reads the file from disk.
/// It must not stamp the repair agent's edit as the app's own write, or the
/// repair guard's "app wrote it" exemption would hide that edit.
@MainActor
final class LoopConfigBlessGateTests: XCTestCase {
    private var root: URL!
    private var rootKey: String { root.resolvingSymlinksInPath().path }
    private var file: URL { LoopEngineConfigStore.fileURL(projectRoot: root) }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-bless-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        LoopRunQueue.release(rootKey: rootKey)
        try? FileManager.default.removeItem(at: root)
    }

    private func store(_ name: String) -> LoopEngineProjectStore {
        LoopEngineProjectStore(loops: [LoopDefinition(name: name, isPrimary: true, config: LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5))])
    }

    func testUISaveDuringARunDoesNotBlessTheAgentsEdit() async throws {
        LoopEngineConfigStore.save(store("before"), projectRoot: root, projectId: "p")
        try await LoopRunQueue.acquire(rootKey: rootKey)
        AppWrittenFiles.adoptCurrentContent(of: file)          // the supervised edit begins

        // The agent rewrites the contract on disk…
        var edited = store("agent")
        edited.loops[0].runsOnSchedule = true
        try JSONEncoder().encode(edited).write(to: file, options: .atomic)
        // …and the user then toggles something, which re-reads and re-saves it.
        var reread = try XCTUnwrap(LoopEngineConfigStore.load(projectRoot: root, projectId: "p"))
        reread.loops[0].name = "renamed by user"
        LoopEngineConfigStore.save(reread, projectRoot: root, projectId: "p")

        XCTAssertFalse(AppWrittenFiles.isUnchangedSinceAppWrite(file),
                       "the guard must still see the file as changed by someone other than the app")
    }

    func testUISaveDuringARunWithNoForeignEditIsTheAppsOwn() async throws {
        LoopEngineConfigStore.save(store("before"), projectRoot: root, projectId: "p")
        try await LoopRunQueue.acquire(rootKey: rootKey)
        AppWrittenFiles.adoptCurrentContent(of: file)

        LoopEngineConfigStore.save(store("edited in the UI"), projectRoot: root, projectId: "p")

        XCTAssertTrue(AppWrittenFiles.isUnchangedSinceAppWrite(file))
    }

    func testSaveOutsideARunIsAlwaysTheAppsOwn() throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(store("hand edited")).write(to: file, options: .atomic)

        LoopEngineConfigStore.save(store("saved"), projectRoot: root, projectId: "p")

        XCTAssertTrue(AppWrittenFiles.isUnchangedSinceAppWrite(file))
    }
}
