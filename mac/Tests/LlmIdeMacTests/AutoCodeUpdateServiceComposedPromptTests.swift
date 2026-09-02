import XCTest
@testable import LlmIdeMacLib

/// `AutoCodeUpdateService.composedPrompt` — the wiring between a task's saved
/// settings, the project's template library, and the pure composer.
///
/// The pure composer is tested on its own; what this covers is the part a
/// wiring regression could break silently: which BODY is chosen. A broken
/// `?? ownPrompt` fallback would leave every scheduled task running an empty
/// prompt, and every composer-level test would still pass.
@MainActor
final class AutoCodeUpdateServiceComposedPromptTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!
    private var projectRoot: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        suiteName = "composed-prompt-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
        projectRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("composed-prompt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: projectRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        UserDefaults().removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: projectRoot)
        suite = nil
        projectRoot = nil
        try super.tearDownWithError()
    }

    private func makeService() -> AutoCodeUpdateService {
        AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: AutoTaskSettings(defaults: suite),
            registry: ProcessedActionsRegistry(
                storeURL: FileManager.default.temporaryDirectory
                    .appendingPathComponent("registry-\(UUID().uuidString).json")),
            logStore: TaskLogStore())
    }

    /// The inertness guarantee, at the level that actually runs: a task nobody
    /// configured sends the prompt it always sent.
    func testUnconfiguredTaskUsesItsOwnPrompt() {
        let service = makeService()
        XCTAssertEqual(
            service.composedPrompt(taskId: "reviewCode", ownPrompt: "Review the code.",
                                   projectRoot: projectRoot.path, writesFiles: false),
            "Review the code.")
    }

    /// Selecting a template replaces the body — the whole point of the feature.
    func testSelectedTemplateReplacesTheOwnPrompt() throws {
        let service = makeService()
        let templates = AutoTaskTemplateStore()
        templates.bindProject(root: projectRoot)
        service.autoTaskTemplates = templates
        service.taskConfigs.bindProject(id: "project-a")

        let template = try XCTUnwrap(templates.create(name: "Custom", body: "Do the custom thing."))
        service.taskConfigs.update(AutoTaskConfig(templateId: template.id), for: "reviewCode")

        XCTAssertEqual(
            service.composedPrompt(taskId: "reviewCode", ownPrompt: "Review the code.",
                                   projectRoot: projectRoot.path, writesFiles: false),
            "Do the custom thing.")
    }

    /// A template deleted out from under a scheduled task must not turn it into
    /// a no-op — it falls back to the prompt it had before.
    func testMissingTemplateFallsBackToTheOwnPrompt() throws {
        let service = makeService()
        let templates = AutoTaskTemplateStore()
        templates.bindProject(root: projectRoot)
        service.autoTaskTemplates = templates
        service.taskConfigs.bindProject(id: "project-a")

        let template = try XCTUnwrap(templates.create(name: "Custom", body: "Do the custom thing."))
        service.taskConfigs.update(AutoTaskConfig(templateId: template.id), for: "reviewCode")
        XCTAssertTrue(templates.delete(id: template.id))

        XCTAssertEqual(
            service.composedPrompt(taskId: "reviewCode", ownPrompt: "Review the code.",
                                   projectRoot: projectRoot.path, writesFiles: false),
            "Review the code.")
    }

    /// No template store wired (no project, older callers, tests) is the same
    /// fallback, not an empty prompt.
    func testNoTemplateStoreFallsBackToTheOwnPrompt() {
        let service = makeService()
        service.taskConfigs.bindProject(id: "project-a")
        service.taskConfigs.update(AutoTaskConfig(templateId: "whatever"), for: "reviewCode")

        XCTAssertEqual(
            service.composedPrompt(taskId: "reviewCode", ownPrompt: "Review the code.",
                                   projectRoot: projectRoot.path, writesFiles: false),
            "Review the code.")
    }

    /// Another project's settings must not reach this one, even though both
    /// were seeded with the same template slugs.
    func testConfigFromAnotherProjectIsNotApplied() throws {
        let service = makeService()
        let templates = AutoTaskTemplateStore()
        templates.bindProject(root: projectRoot)
        service.autoTaskTemplates = templates

        let template = try XCTUnwrap(templates.create(name: "Custom", body: "Project A's prompt."))
        service.taskConfigs.bindProject(id: "project-a")
        service.taskConfigs.update(AutoTaskConfig(templateId: template.id), for: "reviewCode")

        service.taskConfigs.bindProject(id: "project-b")
        XCTAssertEqual(
            service.composedPrompt(taskId: "reviewCode", ownPrompt: "Review the code.",
                                   projectRoot: projectRoot.path, writesFiles: false),
            "Review the code.")
    }

    /// Settings and template compose together, and `writesFiles` reaches the
    /// composer — this is the flag that keeps a review task from being told to
    /// write files its own post-run revert deletes.
    func testSettingsAndTemplateComposeWithReadOnlyWording() throws {
        let service = makeService()
        let templates = AutoTaskTemplateStore()
        templates.bindProject(root: projectRoot)
        service.autoTaskTemplates = templates
        service.taskConfigs.bindProject(id: "project-a")

        let template = try XCTUnwrap(templates.create(name: "Custom", body: "Audit it."))
        service.taskConfigs.update(
            AutoTaskConfig(inputPath: "code", outputPath: "llm-doc/out",
                           skillName: "code-review",
                           skillDirective: "Use the code-review skill:",
                           templateId: template.id),
            for: "reviewCode")

        let readOnly = service.composedPrompt(taskId: "reviewCode", ownPrompt: "unused",
                                              projectRoot: projectRoot.path, writesFiles: false)
        XCTAssertTrue(readOnly.hasPrefix("Use the code-review skill:"))
        XCTAssertTrue(readOnly.contains("\(projectRoot.path)/code"))
        XCTAssertTrue(readOnly.contains("READ-ONLY"))
        XCTAssertTrue(readOnly.hasSuffix("Audit it."))

        let writing = service.composedPrompt(taskId: "reviewCode", ownPrompt: "unused",
                                             projectRoot: projectRoot.path, writesFiles: true)
        XCTAssertTrue(writing.contains("write every file"))
    }
}
