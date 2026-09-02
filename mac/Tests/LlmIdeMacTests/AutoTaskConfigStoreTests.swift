import XCTest
@testable import LlmIdeMacLib

/// Per-task Auto Task settings: persistence, project scoping, the empty-config
/// rule, and the template-rename repointing that keeps a renamed template
/// attached to the tasks using it.
@MainActor
final class AutoTaskConfigStoreTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "auto-task-config-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    /// Most tests operate inside one project; the scoping tests bind explicitly.
    private func makeStore(project: String? = "project-a") -> AutoTaskConfigStore {
        let store = AutoTaskConfigStore(defaults: suite)
        store.bindProject(id: project)
        return store
    }

    func testUnconfiguredTaskReturnsEmptyConfig() {
        XCTAssertTrue(makeStore().config(for: "reviewCode").isEmpty)
    }

    func testUpdateThenReloadRoundTrips() {
        let store = makeStore()
        store.update(AutoTaskConfig(inputPath: "code", outputPath: "llm-doc/out",
                                    skillName: "code-review",
                                    skillDirective: "Use the code-review skill:",
                                    templateId: "nightly"),
                     for: "reviewCode")

        let reloaded = makeStore()
        let config = reloaded.config(for: "reviewCode")
        XCTAssertEqual(config.inputPath, "code")
        XCTAssertEqual(config.outputPath, "llm-doc/out")
        XCTAssertEqual(config.skillName, "code-review")
        XCTAssertEqual(config.templateId, "nightly")
    }

    // MARK: - Project scoping

    /// The reason scoping exists: every project seeds the SAME template slugs,
    /// so a global bucket would resolve "review-code" against whichever project
    /// happens to be open and run a prompt written for a different repo.
    func testConfigsDoNotLeakBetweenProjects() {
        let store = makeStore(project: "project-a")
        store.update(AutoTaskConfig(inputPath: "code/payments", templateId: "review-code"),
                     for: "reviewCode")

        store.bindProject(id: "project-b")
        XCTAssertTrue(store.config(for: "reviewCode").isEmpty)

        store.bindProject(id: "project-a")
        XCTAssertEqual(store.config(for: "reviewCode").templateId, "review-code")
        XCTAssertEqual(store.config(for: "reviewCode").inputPath, "code/payments")
    }

    func testEachProjectPersistsItsOwnSettings() {
        let store = makeStore(project: "project-a")
        store.update(AutoTaskConfig(templateId: "a-prompt"), for: "reviewCode")
        store.bindProject(id: "project-b")
        store.update(AutoTaskConfig(templateId: "b-prompt"), for: "reviewCode")

        let reloaded = AutoTaskConfigStore(defaults: suite)
        reloaded.bindProject(id: "project-a")
        XCTAssertEqual(reloaded.config(for: "reviewCode").templateId, "a-prompt")
        reloaded.bindProject(id: "project-b")
        XCTAssertEqual(reloaded.config(for: "reviewCode").templateId, "b-prompt")
    }

    /// Settings made with no project open are kept in their own bucket rather
    /// than dropped — and must not appear once a project opens.
    func testNoProjectScopeIsSeparate() {
        let store = makeStore(project: nil)
        store.update(AutoTaskConfig(inputPath: "code"), for: "reviewCode")
        XCTAssertEqual(store.config(for: "reviewCode").inputPath, "code")

        store.bindProject(id: "project-a")
        XCTAssertTrue(store.config(for: "reviewCode").isEmpty)
    }

    // MARK: - Normalization

    /// Blank strings are cleared, not stored — an emptied text field must
    /// remove the setting rather than persist "".
    func testBlankFieldsAreNormalizedToNil() {
        let store = makeStore()
        store.update(AutoTaskConfig(inputPath: "  ", outputPath: "", templateId: "t"),
                     for: "reviewCode")
        let config = store.config(for: "reviewCode")
        XCTAssertNil(config.inputPath)
        XCTAssertNil(config.outputPath)
        XCTAssertEqual(config.templateId, "t")
    }

    /// Clearing every field drops the record instead of leaving an empty one
    /// behind for a task the user merely opened.
    func testAllBlankConfigRemovesTheRecord() {
        let store = makeStore()
        store.update(AutoTaskConfig(inputPath: "code"), for: "reviewCode")
        XCTAssertEqual(store.configs.count, 1)
        store.update(AutoTaskConfig(), for: "reviewCode")
        XCTAssertTrue(store.configs.isEmpty)
    }

    func testRemoveDropsOneTaskOnly() {
        let store = makeStore()
        store.update(AutoTaskConfig(inputPath: "code"), for: "a")
        store.update(AutoTaskConfig(inputPath: "data"), for: "b")
        store.remove(taskId: "a")
        XCTAssertNil(store.configs["a"])
        XCTAssertEqual(store.configs["b"]?.inputPath, "data")
    }

    // MARK: - Template retargeting

    /// A rename changes a template's id (the id is the filename stem), so every
    /// task pointing at the old one must follow — otherwise they silently fall
    /// back to their own prompts.
    func testRetargetTemplateFollowsARename() {
        let store = makeStore()
        store.update(AutoTaskConfig(templateId: "old"), for: "reviewCode")
        store.update(AutoTaskConfig(templateId: "old"), for: "reviewDoc")
        store.update(AutoTaskConfig(templateId: "other"), for: "generateDoc")

        store.retargetTemplate(from: "old", to: "new")

        XCTAssertEqual(store.config(for: "reviewCode").templateId, "new")
        XCTAssertEqual(store.config(for: "reviewDoc").templateId, "new")
        XCTAssertEqual(store.config(for: "generateDoc").templateId, "other")
    }

    /// The template file that moved belongs to ONE project; a same-named
    /// template elsewhere is a different file and must be left alone.
    func testRetargetDoesNotReachIntoOtherProjects() {
        let store = makeStore(project: "project-a")
        store.update(AutoTaskConfig(templateId: "review-code"), for: "reviewCode")
        store.bindProject(id: "project-b")
        store.update(AutoTaskConfig(templateId: "review-code"), for: "reviewCode")

        store.retargetTemplate(from: "review-code", to: "renamed")

        XCTAssertEqual(store.config(for: "reviewCode").templateId, "renamed")
        store.bindProject(id: "project-a")
        XCTAssertEqual(store.config(for: "reviewCode").templateId, "review-code")
    }

    /// A delete clears the reference; a config that held nothing else goes away
    /// entirely rather than lingering as an empty record.
    func testRetargetToNilClearsAndPrunes() {
        let store = makeStore()
        store.update(AutoTaskConfig(templateId: "gone"), for: "reviewCode")
        store.update(AutoTaskConfig(inputPath: "code", templateId: "gone"), for: "reviewDoc")

        store.retargetTemplate(from: "gone", to: nil)

        XCTAssertNil(store.configs["reviewCode"])
        XCTAssertNil(store.config(for: "reviewDoc").templateId)
        XCTAssertEqual(store.config(for: "reviewDoc").inputPath, "code")
    }

    func testRetargetPersists() {
        let store = makeStore()
        store.update(AutoTaskConfig(templateId: "old"), for: "reviewCode")
        store.retargetTemplate(from: "old", to: "new")

        let reloaded = makeStore()
        XCTAssertEqual(reloaded.config(for: "reviewCode").templateId, "new")
    }
}
