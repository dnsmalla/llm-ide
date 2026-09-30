import XCTest
@testable import LlmIdeMacLib

/// `system/loop.json` versioning, safe decoding/quarantine, lenient stage
/// kinds, template-store preservation, and stable default ids.
@MainActor
final class LoopStoreVersioningTests: XCTestCase {
    private var projectRoot: URL!
    private var repo: URL!
    private let projectId = "proj-v"

    private func freshDefaults() -> UserDefaults {
        let name = "loop-store-versioning-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        addTeardownBlock { d.removePersistentDomain(forName: name) }
        return d
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-store-versioning-\(UUID().uuidString)", isDirectory: true)
        projectRoot = base.appendingPathComponent("proj", isDirectory: true)
        repo = base.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: projectRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try Data("// swift-tools-version:5.9\n".utf8).write(to: repo.appendingPathComponent("Package.swift"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: projectRoot.deletingLastPathComponent())
        try super.tearDownWithError()
    }

    private var fileURL: URL { LoopEngineConfigStore.fileURL(projectRoot: projectRoot) }

    private func writeRaw(_ json: String) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(json.utf8).write(to: fileURL)
    }

    private func v1Json(schedule: String = "true") -> String {
        """
        {"loops":[{"id":"L1","name":"Main","isPrimary":true,"scopeGlobs":[],
        "runsOnSchedule":\(schedule),
        "config":{"stages":[{"id":"s1","name":"Test","kind":"shellCommand","command":"make test","order":0}]}}]}
        """
    }

    func testMigrationRunsOnceKeyedOnFileVersionAndIsIdempotent() throws {
        try writeRaw(v1Json())
        let first = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId,
                                                gitRoot: nil, defaults: freshDefaults())
        XCTAssertTrue(first.loops.allSatisfy { !$0.runsOnSchedule })
        XCTAssertEqual(first.schemaVersion, 2)
        let after = try Data(contentsOf: fileURL)
        XCTAssertTrue(String(decoding: after, as: UTF8.self).contains("\"schemaVersion\" : 2"))

        // The user opts in afterwards; a second run must not revert it.
        var store = first
        store.loops[0].runsOnSchedule = true
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId)
        let second = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId,
                                                 gitRoot: nil, defaults: freshDefaults())
        XCTAssertTrue(second.loops[0].runsOnSchedule)
    }

    func testFreshUserDefaultsDoesNotRewriteAV2File() throws {
        var store = LoopEngineProjectStore(loops: [LoopDefinition(
            id: "L1", name: "Main", isPrimary: true, runsOnSchedule: true,
            config: LoopEngineConfig(stages: [LoopStage(id: "s1", name: "Test", kind: .shellCommand,
                                                        command: "make test", order: 0)]))])
        store.schemaVersion = 2
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId)
        let before = try Data(contentsOf: fileURL)
        let loaded = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId,
                                                 gitRoot: nil, defaults: freshDefaults())
        XCTAssertTrue(loaded.loops[0].runsOnSchedule)
        XCTAssertEqual(try Data(contentsOf: fileURL), before)
    }

    func testMissingRunsOnScheduleAtV2DecodesFalse() throws {
        try writeRaw(v1Json(schedule: "null").replacingOccurrences(of: "\"runsOnSchedule\":null,", with: "")
            .replacingOccurrences(of: "{\"loops\"", with: "{\"schemaVersion\":2,\"loops\""))
        let store = try XCTUnwrap(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                             defaults: freshDefaults()))
        XCTAssertFalse(store.loops[0].runsOnSchedule)
    }

    func testNewerVersionFileIsNeverOverwritten() throws {
        try writeRaw(v1Json().replacingOccurrences(of: "{\"loops\"", with: "{\"schemaVersion\":9,\"future\":1,\"loops\""))
        let before = try Data(contentsOf: fileURL)
        let loaded = try XCTUnwrap(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                              defaults: freshDefaults()))
        XCTAssertEqual(loaded.schemaVersion, 9)
        LoopEngineConfigStore.save(loaded, projectRoot: projectRoot, projectId: projectId)
        _ = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId, gitRoot: nil)
        XCTAssertEqual(try Data(contentsOf: fileURL), before)
        XCTAssertEqual(LoopStoreNotices.shared.notice(forFile: fileURL), .newerVersion(9))
    }

    func testReadErrorDoesNotQuarantineOrOverwrite() throws {
        try writeRaw(v1Json())
        let before = try Data(contentsOf: fileURL)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: fileURL.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: fileURL.path) }
        try XCTSkipIf(FileManager.default.isReadableFile(atPath: fileURL.path), "running with read access to mode 000 files")
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: freshDefaults()))
        _ = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId, gitRoot: repo)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: fileURL.path)
        XCTAssertEqual(try Data(contentsOf: fileURL), before)
        let siblings = try FileManager.default.contentsOfDirectory(atPath: fileURL.deletingLastPathComponent().path)
        XCTAssertFalse(siblings.contains { $0.contains("corrupt") })
        XCTAssertEqual(LoopStoreNotices.shared.notice(forFile: fileURL), .readFailed)
    }

    func testDecodeErrorQuarantinesAndPostsNotice() throws {
        try writeRaw("{ not json")
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: freshDefaults()))
        guard case .quarantined? = LoopStoreNotices.shared.notice(forFile: fileURL) else {
            return XCTFail("expected a quarantine notice")
        }
    }

    func testUnknownStageKindRoundTripsAndNeverRuns() throws {
        let json = """
        {"schemaVersion":2,"loops":[{"id":"L1","name":"Main","isPrimary":true,"runsOnSchedule":false,
        "scopeGlobs":[],"config":{"stages":[
        {"id":"s1","name":"Test","kind":"shellCommand","command":"make test","order":0},
        {"id":"s2","name":"Deploy","kind":"teleport","order":1,"destination":"mars","enabled":true}]}}]}
        """
        try writeRaw(json)
        let store = try XCTUnwrap(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                             defaults: freshDefaults()))
        let stage = store.loops[0].config.stages[1]
        XCTAssertEqual(stage.kind, .unsupported)
        XCTAssertFalse(stage.enabled)
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId)
        let text = try String(contentsOf: fileURL, encoding: .utf8)
        XCTAssertTrue(text.contains("\"teleport\""))
        XCTAssertTrue(text.contains("\"mars\""))
        let reloaded = try XCTUnwrap(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                                defaults: freshDefaults()))
        XCTAssertEqual(reloaded.loops[0].config.stages[1].kind, .unsupported)
        XCTAssertEqual(reloaded.loops[0].config.stages[0].command, "make test")
    }

    func testTemplateDecodeFailureIsPreservedAndNotOverwritten() {
        let d = freshDefaults()
        let junk = Data("{\"storeVersion\":1,\"templates\":\"oops\"}".utf8)
        d.set(junk, forKey: "loopTemplateStore")
        let store = LoopTemplateStore(defaults: d)
        XCTAssertTrue(store.storedDataUndecodable)
        _ = try? store.save(name: "Mine", summary: "", config: LoopEngineConfig(stages: []))
        XCTAssertEqual(d.data(forKey: "loopTemplateStore"), junk)
        XCTAssertEqual(d.data(forKey: LoopTemplateStore.undecodableBackupKey), junk)
    }

    func testUnsavedProjectReturnsIdenticalIdsAcrossReads() {
        func ids() -> [String] {
            let s = LoopEngineConfigStore.loops(projectRoot: nil, projectId: projectId, gitRoot: repo,
                                                defaults: freshDefaults())
            return s.loops.flatMap { [$0.id] + $0.config.stages.map(\.id) }
        }
        let a = ids()
        XCTAssertFalse(a.isEmpty)
        XCTAssertEqual(a, ids())
        XCTAssertTrue(a.contains("default-regression"))
        XCTAssertTrue(a.contains("regression/regression"))
    }

    func testNewerFileThatNoLongerDecodesIsLeftByteIdentical() throws {
        let reshaped = """
        {"schemaVersion":3,"loops":[{"id":"L1","name":"Main","config":"reshaped"}],"extra":{"a":[1,2]}}
        """
        try writeRaw(reshaped)
        let before = try Data(contentsOf: fileURL)
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: freshDefaults()))
        let ensured = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId, gitRoot: repo)
        LoopEngineConfigStore.save(ensured, projectRoot: projectRoot, projectId: projectId)
        XCTAssertEqual(try Data(contentsOf: fileURL), before)
        let siblings = try FileManager.default.contentsOfDirectory(atPath: fileURL.deletingLastPathComponent().path)
        XCTAssertFalse(siblings.contains { $0.contains("corrupt") })
        XCTAssertEqual(LoopStoreNotices.shared.notice(forFile: fileURL), .newerVersion(3))
    }

    func testNewerFileWithUnknownSeverityIsNotTouched() throws {
        try writeRaw(v1Json().replacingOccurrences(of: "\"order\":0}", with: "\"order\":0,\"severity\":\"fatal\"}")
            .replacingOccurrences(of: "{\"loops\"", with: "{\"schemaVersion\":3,\"loops\""))
        let before = try Data(contentsOf: fileURL)
        _ = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId, gitRoot: repo)
        XCTAssertEqual(try Data(contentsOf: fileURL), before)
    }

    func testUnknownSeverityDecodesAsBlocking() throws {
        let data = Data("{\"id\":\"s\",\"name\":\"n\",\"kind\":\"shellCommand\",\"order\":0,\"severity\":\"fatal\"}".utf8)
        XCTAssertEqual(try JSONDecoder().decode(LoopStage.self, from: data).severity, .blocking)
    }

    func testLegacyMachineFlagMakesV1FileKeepItsOptIn() throws {
        let d = freshDefaults()
        d.set(true, forKey: "loopScheduleOptInMigrated.\(projectId)")
        try writeRaw(v1Json())
        let store = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId,
                                                gitRoot: nil, defaults: d)
        XCTAssertTrue(store.loops[0].runsOnSchedule)
        XCTAssertEqual(store.schemaVersion, 2)
        // Without the hint the same file is normalised.
        try writeRaw(v1Json())
        let other = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId,
                                                gitRoot: nil, defaults: freshDefaults())
        XCTAssertFalse(other.loops[0].runsOnSchedule)
    }

    func testNoticesClearAfterACleanLoad() throws {
        try writeRaw("{ not json")
        _ = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId, defaults: freshDefaults())
        XCTAssertNotNil(LoopStoreNotices.shared.notice(forFile: fileURL))
        try writeRaw(v1Json())
        _ = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId, defaults: freshDefaults())
        XCTAssertNil(LoopStoreNotices.shared.notice(forFile: fileURL))
    }

    func testTemplateSaveThrowsWhileUndecodableAndResetRestoresIt() throws {
        let d = freshDefaults()
        let junk = Data("not json".utf8)
        d.set(junk, forKey: "loopTemplateStore")
        let store = LoopTemplateStore(defaults: d)
        XCTAssertThrowsError(try store.save(name: "Mine", summary: "", config: LoopEngineConfig(stages: [])))
        XCTAssertTrue(store.customTemplates.isEmpty)
        store.resetCustomTemplates()
        XCTAssertFalse(store.storedDataUndecodable)
        XCTAssertEqual(d.data(forKey: LoopTemplateStore.undecodableBackupKey), junk)
        XCTAssertNoThrow(try store.save(name: "Mine", summary: "", config: LoopEngineConfig(stages: [])))
    }
}
