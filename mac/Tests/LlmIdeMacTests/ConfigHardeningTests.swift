import XCTest
@testable import LlmIdeMacLib

/// Load-time hardening for persisted settings: values written by an older
/// build, a tampered plist, or a corrupt blob must degrade safely instead of
/// shipping a retired model, a non-local server URL, a negative slice count,
/// or silently replacing the user's saved config with an empty one.
final class ConfigHardeningTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!
    /// Stash target for corrupt-blob copies so tests never write into the
    /// real Application Support directory.
    private var stashDir: URL!

    override func setUp() {
        super.setUp()
        stashDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("config-hardening-stash-\(UUID().uuidString)", isDirectory: true)
        suiteName = "config-hardening-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        try? FileManager.default.removeItem(at: stashDir)
        stashDir = nil
        super.tearDown()
    }

    // MARK: - AppConfig load

    func testRetiredPurposeModelIdIsMigratedAtInit() throws {
        let purpose = try XCTUnwrap(ModelPurpose.allCases.first)
        suite.set("gpt-4o", forKey: purpose.settingsKey)

        let config = AppConfig(userDefaults: suite)

        XCTAssertEqual(config.purposeModelIds[purpose], AppConfig.retiredModelIds["gpt-4o"])
    }

    func testUnknownPurposeModelIdIsKeptVerbatim() throws {
        let purpose = try XCTUnwrap(ModelPurpose.allCases.first)
        suite.set("some-live-model", forKey: purpose.settingsKey)

        XCTAssertEqual(AppConfig(userDefaults: suite).purposeModelIds[purpose], "some-live-model")
    }

    func testNonLocalStoredServerURLFallsBackToDefault() {
        suite.set("http://evil.example.com:3456", forKey: "serverURL")

        let config = AppConfig(userDefaults: suite)

        XCTAssertEqual(config.serverURL, "http://127.0.0.1:\(BackendManager.defaultBackendPort)")
    }

    func testLocalStoredServerURLIsKept() {
        suite.set("http://localhost:4567", forKey: "serverURL")

        XCTAssertEqual(AppConfig(userDefaults: suite).serverURL, "http://localhost:4567")
    }

    // MARK: - AutoTaskSettings clamps

    @MainActor
    func testStoredNonPositiveLookbacksAreClampedAtInit() {
        suite.set(-4, forKey: "autoCodeUpdateLookbackCount")
        suite.set(0, forKey: "autoCodeLookbackDays")

        let settings = AutoTaskSettings(defaults: suite)

        XCTAssertEqual(settings.lookbackMeetingCount, 1)
        XCTAssertEqual(settings.lookbackDays, 1)
    }

    @MainActor
    func testWritingNonPositiveLookbackIsClampedAndPersisted() {
        let settings = AutoTaskSettings(defaults: suite)
        settings.lookbackMeetingCount = 9
        settings.lookbackMeetingCount = -2

        XCTAssertEqual(settings.lookbackMeetingCount, 1)
        XCTAssertEqual(suite.integer(forKey: "autoCodeUpdateLookbackCount"), 1)
    }

    @MainActor
    func testVerifyTimeoutIsClamped() {
        let settings = AutoTaskSettings(defaults: suite)

        settings.regressionVerifyTimeout = -5
        XCTAssertEqual(settings.regressionVerifyTimeout, AutoTaskSettings.defaultRegressionVerifyTimeout)

        settings.regressionVerifyTimeout = 1_000_000
        XCTAssertEqual(settings.regressionVerifyTimeout, AutoTaskSettings.maxRegressionVerifyTimeout)

        settings.regressionVerifyTimeout = 45
        XCTAssertEqual(settings.regressionVerifyTimeout, 45)
    }

    // MARK: - AutoTaskConfigStore

    @MainActor
    func testCorruptConfigBlobIsNotKeptAroundToBeOverwritten() {
        suite.set(Data("{not valid json".utf8), forKey: AutoTaskConfigStore.defaultsKey)

        let store = AutoTaskConfigStore(defaults: suite, stashDirectory: stashDir)

        XCTAssertTrue(store.byProject.isEmpty)
        // The blob was stashed to disk and the key cleared, so the first save
        // starts clean rather than clobbering unrecoverable bytes.
        XCTAssertNil(suite.data(forKey: AutoTaskConfigStore.defaultsKey))
        XCTAssertFalse(store.isReadOnly)
    }

    @MainActor
    func testStashFailureKeepsKeyAndMakesStoreReadOnly() throws {
        let blob = Data("{not valid json".utf8)
        suite.set(blob, forKey: AutoTaskConfigStore.defaultsKey)
        // A regular FILE where the stash directory should be: createDirectory
        // fails and the write underneath it cannot succeed.
        let blocker = FileManager.default.temporaryDirectory
            .appendingPathComponent("stash-blocker-\(UUID().uuidString)")
        try Data().write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }

        let store = AutoTaskConfigStore(defaults: suite, stashDirectory: blocker)

        XCTAssertTrue(store.isReadOnly)
        XCTAssertEqual(suite.data(forKey: AutoTaskConfigStore.defaultsKey), blob)
        var config = AutoTaskConfig()
        config.inputPath = "docs"
        store.update(config, for: "task")
        XCTAssertEqual(suite.data(forKey: AutoTaskConfigStore.defaultsKey), blob,
                       "a read-only store must not overwrite the corrupt blob")
    }

    @MainActor
    func testReadOnlyStoreDoesNotMutateInMemoryState() throws {
        suite.set(Data("{not valid json".utf8), forKey: AutoTaskConfigStore.defaultsKey)
        let blocker = FileManager.default.temporaryDirectory
            .appendingPathComponent("stash-blocker-\(UUID().uuidString)")
        try Data().write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        let store = AutoTaskConfigStore(defaults: suite, stashDirectory: blocker)
        XCTAssertTrue(store.isReadOnly)

        var config = AutoTaskConfig()
        config.inputPath = "docs"
        store.update(config, for: "task")
        store.remove(taskId: "task")
        store.retargetTemplate(from: "a", to: "b")

        XCTAssertTrue(store.byProject.isEmpty, "an edit that cannot persist must not appear saved")
        XCTAssertEqual(store.config(for: "task"), AutoTaskConfig())
    }

    // MARK: - CustomProvider

    func testProviderMissingOptionalFieldsStillDecodes() throws {
        let json = Data(#"[{"name":"GLM","baseURL":"https://example.com/v1"}]"#.utf8)

        let decoded = try JSONDecoder().decode([CustomProvider].self, from: json)

        XCTAssertEqual(decoded.count, 1)
        XCTAssertEqual(decoded[0].name, "GLM")
        XCTAssertTrue(decoded[0].isEnabled)
        XCTAssertTrue(decoded[0].isOpenAICompatible)
        XCTAssertTrue(decoded[0].models.isEmpty)
        XCTAssertFalse(decoded[0].id.isEmpty)
    }

    func testProviderLoadDistinguishesEmptyFromUndecodable() {
        XCTAssertEqual(CustomProvider.load(from: suite, stashDirectory: stashDir), .loaded([]))

        suite.set(Data("garbage".utf8), forKey: CustomProvider.defaultsKey)
        XCTAssertEqual(CustomProvider.load(from: suite, stashDirectory: stashDir), .failed)
        // Left in place: removing it would make the next load look "empty"
        // and let a sync push an empty registry to the server.
        XCTAssertNotNil(suite.data(forKey: CustomProvider.defaultsKey))
    }

    func testSaveAndDeleteRefuseWhileListIsUnreadable() {
        let blob = Data("garbage".utf8)
        suite.set(blob, forKey: CustomProvider.defaultsKey)
        let provider = CustomProvider(name: "GLM", baseURL: "https://example.com/v1", apiKey: "k")

        XCTAssertTrue(CustomProvider.isListUnreadable(in: suite))
        XCTAssertFalse(provider.save(to: suite))
        XCTAssertFalse(provider.delete(from: suite))
        XCTAssertFalse(CustomProvider.saveAll([provider], to: suite))
        XCTAssertEqual(suite.data(forKey: CustomProvider.defaultsKey), blob)
    }

    /// save/delete must refuse without writing a stash file (they use the
    /// side-effect-free read); discard with an injected dir is the only writer.
    func testRefusedSaveDoesNotWriteStashFile() throws {
        suite.set(Data("garbage".utf8), forKey: CustomProvider.defaultsKey)
        let provider = CustomProvider(name: "GLM", baseURL: "https://example.com/v1", apiKey: "k")
        let root = AppIdentity.applicationSupportRoot(fileManager: .default)
        func corruptFiles() -> Set<String> {
            let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
            return Set(names.filter { $0.hasPrefix("\(CustomProvider.defaultsKey).json.corrupt-") })
        }
        let before = corruptFiles()

        XCTAssertFalse(provider.save(to: suite))
        XCTAssertFalse(provider.delete(from: suite))

        XCTAssertEqual(corruptFiles(), before)
    }

    func testDuplicateIdLessProvidersGetUniqueStableIds() throws {
        let json = Data(#"""
        [{"name":"GLM","baseURL":"https://example.com/v1"},
         {"name":"GLM","baseURL":"https://example.com/v1"}]
        """#.utf8)
        suite.set(json, forKey: CustomProvider.defaultsKey)

        guard case .loaded(let first) = CustomProvider.load(from: suite),
              case .loaded(let second) = CustomProvider.load(from: suite) else {
            return XCTFail("expected readable list")
        }
        XCTAssertEqual(first.count, 2)
        XCTAssertNotEqual(first[0].id, first[1].id)
        XCTAssertEqual(first.map(\.id), second.map(\.id))

        XCTAssertTrue(first[1].save(to: suite))
        guard case .loaded(let after) = CustomProvider.load(from: suite) else {
            return XCTFail("expected readable list")
        }
        XCTAssertEqual(after.count, 2)
        XCTAssertTrue(first[1].delete(from: suite))
        guard case .loaded(let remaining) = CustomProvider.load(from: suite) else {
            return XCTFail("expected readable list")
        }
        XCTAssertEqual(remaining.map(\.id), [first[0].id])
    }

    func testDiscardUnreadableListRemovesOnlyAfterVerifiedStash() throws {
        let blob = Data("garbage".utf8)
        suite.set(blob, forKey: CustomProvider.defaultsKey)

        XCTAssertTrue(CustomProvider.discardUnreadableList(from: suite, stashDirectory: stashDir))
        XCTAssertNil(suite.data(forKey: CustomProvider.defaultsKey))
        let stashed = try FileManager.default.contentsOfDirectory(atPath: stashDir.path)
        XCTAssertEqual(stashed.count, 1)

        // Stash dir blocked by a file -> nothing is removed.
        suite.set(blob, forKey: CustomProvider.defaultsKey)
        let blocker = FileManager.default.temporaryDirectory
            .appendingPathComponent("stash-blocker-\(UUID().uuidString)")
        try Data().write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        XCTAssertFalse(CustomProvider.discardUnreadableList(from: suite, stashDirectory: blocker))
        XCTAssertEqual(suite.data(forKey: CustomProvider.defaultsKey), blob)
    }

    func testIdLessProviderGetsStableIdAndSaveDoesNotDuplicate() throws {
        let json = Data(#"[{"name":"GLM","baseURL":"https://example.com/v1"}]"#.utf8)
        suite.set(json, forKey: CustomProvider.defaultsKey)

        guard case .loaded(let first) = CustomProvider.load(from: suite),
              case .loaded(let second) = CustomProvider.load(from: suite) else {
            return XCTFail("expected readable list")
        }
        XCTAssertEqual(first[0].id, second[0].id)

        XCTAssertTrue(first[0].save(to: suite))
        guard case .loaded(let after) = CustomProvider.load(from: suite) else {
            return XCTFail("expected readable list")
        }
        XCTAssertEqual(after.count, 1)
    }

    // MARK: - NotesFolderConfig

    func testIsInTrashRecognisesTrashPaths() {
        XCTAssertTrue(NotesFolderConfig.isInTrash(URL(fileURLWithPath: "/Users/x/.Trash/notes")))
        XCTAssertTrue(NotesFolderConfig.isInTrash(URL(fileURLWithPath: "/Volumes/V/.Trashes/501/notes")))
        XCTAssertFalse(NotesFolderConfig.isInTrash(URL(fileURLWithPath: "/Users/x/Documents/notes")))
    }

    func testBookmarkResolvingIntoTrashFallsBackToStoredPath() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("notes-trash-\(UUID().uuidString)")
        let trashed = root.appendingPathComponent(".Trash/notes", isDirectory: true)
        let original = root.appendingPathComponent("orig", isDirectory: true)
        try fm.createDirectory(at: original, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }

        let config = NotesFolderConfig(userDefaults: suite)
        // The bookmark points into a trash folder, while the stored path
        // still names the folder's original location.
        try config.setFolder(trashed)
        suite.set(original.path, forKey: "MEETNOTES_NOTES_FOLDER_PATH")

        XCTAssertEqual(config.currentFolder.resolvingSymlinksInPath().path,
                       original.resolvingSymlinksInPath().path)
    }
}
