import XCTest
@testable import LlmIdeMac

@MainActor
final class GenerationViewModelTests: XCTestCase {

    private func makeSource() -> DocGenSource {
        .file(url: URL(fileURLWithPath: "/tmp/a.md"), name: "a.md")
    }

    private func makeTemplate() -> DocTemplate {
        DocTemplate(id: UUID(), name: "Sprint Review", sections: ["Goal"])
    }

    private func makeCommand() -> DocCommand {
        DocCommand(id: UUID(), name: "Summarize", instruction: "Be brief.")
    }

    func testCannotGenerateWithoutSources() {
        let vm = GenerationViewModel()
        vm.selectedTemplate = makeTemplate()
        XCTAssertFalse(vm.canGenerate)
    }

    func testCannotGenerateWithoutTemplateOrCommand() {
        let vm = GenerationViewModel()
        vm.selectedSources = [makeSource()]
        XCTAssertFalse(vm.canGenerate)
    }

    func testCommandAloneIsEnough() {
        let vm = GenerationViewModel()
        vm.selectedSources = [makeSource()]
        vm.selectedCommand = makeCommand()
        XCTAssertTrue(vm.canGenerate)
    }

    func testTemplateAloneIsEnough() {
        let vm = GenerationViewModel()
        vm.selectedSources = [makeSource()]
        vm.selectedTemplate = makeTemplate()
        XCTAssertTrue(vm.canGenerate)
    }

    /// Regression for the Visual "Use chat" critical bug: `relaxRequirements`
    /// must only lift the template/command requirement, never the source
    /// requirement — `generate()` has no content to send with zero sources
    /// and always fails with "No readable source content…" regardless of
    /// `relaxRequirements`. Arming Generate here used to present a button
    /// that instantly failed every time it was pressed.
    func testRelaxedModeStillRequiresASource() {
        let vm = GenerationViewModel()
        vm.relaxRequirements = true
        XCTAssertTrue(vm.selectedSources.isEmpty)
        XCTAssertFalse(vm.canGenerate,
                       "chat mode with no sources ticked must not present a generate-able state")

        vm.selectedSources = [makeSource()]
        XCTAssertTrue(vm.canGenerate,
                      "once a source is ticked, chat mode should not also require a template/command")
    }

    func testOutputFilenamePrefersTemplateThenCommand() {
        let vm = GenerationViewModel()
        XCTAssertEqual(vm.outputFilename, "generated-doc")
        vm.selectedCommand = makeCommand()
        XCTAssertEqual(vm.outputFilename, "Summarize-doc")
        vm.selectedTemplate = makeTemplate()
        XCTAssertEqual(vm.outputFilename, "Sprint Review-doc")
    }

    func testResetClearsEditState() {
        let vm = GenerationViewModel()
        vm.editPrompt = "make it shorter"
        vm.editedContent = "draft"
        vm.resetToIdle()
        XCTAssertEqual(vm.editPrompt, "")
        XCTAssertEqual(vm.editedContent, "")
    }

    func testResetClearsSavedFlag() {
        let vm = GenerationViewModel()
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        // isSaved is private(set); drive it through save() rather than
        // poking the property directly. A real temp directory keeps this
        // hermetic (no project root, no Downloads folder side effects).
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("docgen-test-\(UUID().uuidString)")
        var config = DocGenOutputConfig()
        config.localFolderPath = tmpDir.path
        // revealInFinder: false — this still performs a real write (the
        // isSaved/dedupe behavior stays genuinely covered), it just skips
        // the NSWorkspace Finder-reveal side effect so the test doesn't pop
        // a Finder window from a headless run. Production callers (the
        // prompt bar's Save button) keep the default `true`.
        vm.save(content: "draft", api: api, config: config, revealInFinder: false)
        XCTAssertTrue(vm.isSaved)
        vm.resetToIdle()
        XCTAssertFalse(vm.isSaved)
        try? FileManager.default.removeItem(at: tmpDir)
    }

    func testIsBusyOnlyWhileGenerating() {
        let vm = GenerationViewModel()
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        XCTAssertFalse(vm.isBusy)
        vm.selectedSources = [makeSource()]
        vm.selectedTemplate = makeTemplate()
        vm.generate(api: api)
        XCTAssertTrue(vm.isBusy)
        vm.cancelGeneration()
        XCTAssertFalse(vm.isBusy)
    }

    // MARK: - Revision failure invariant: no worse than before pressing Apply

    /// `LlmIdeAPIClient(baseURL:)` with no `sessionStore` makes
    /// `generateDoc(...)` throw `APIError.noSession` deterministically,
    /// with no real network I/O — a convenient, fast, always-reproducible
    /// stand-in for "the revision request failed" (which is exactly what a
    /// timeout, rate limit, 5xx, or a 400 from `validateDocRequest` would
    /// also produce: an error caught by `applyEdit`'s `catch`).
    private func failingAPI() -> LlmIdeAPIClient {
        LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
    }

    func testFailedRevisionPreservesDocument() async throws {
        let vm = GenerationViewModel()
        let original = "# Sprint Review\n\nOriginal content the user has not saved yet."
        vm.editedContent = original
        vm.editPrompt = "Make section 2 shorter"

        vm.applyEdit(api: failingAPI())
        XCTAssertTrue(vm.isBusy, "should flip to .generating synchronously, same as generate()")

        // Let the scheduled Task run to completion — generateDoc throws
        // .noSession with no real network wait, so this is generous, not tight.
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertFalse(vm.isBusy)
        XCTAssertEqual(vm.editedContent, original,
                       "a failed revision must not lose the document that was there before Apply Edit")
        XCTAssertNotNil(vm.editError, "the failure must be reported, not silently swallowed")
        switch vm.generationState {
        case .done(let text, _):
            XCTAssertEqual(text, original)
        default:
            XCTFail("expected generationState back at .done(<pre-edit document>), got \(vm.generationState)")
        }
    }

    func testCancelledRevisionRestoresPriorDocument() {
        let vm = GenerationViewModel()
        let original = "# Sprint Review\n\nOriginal content the user has not saved yet."
        vm.editedContent = original
        vm.editPrompt = "Add a risks section"

        vm.applyEdit(api: failingAPI())
        XCTAssertTrue(vm.isBusy)
        vm.cancelGeneration()

        XCTAssertFalse(vm.isBusy)
        XCTAssertEqual(vm.editedContent, original,
                       "cancelling a revision must not lose the document that was there before Apply Edit")
        switch vm.generationState {
        case .done(let text, _):
            XCTAssertEqual(text, original)
        default:
            XCTFail("expected cancelling a revision to restore .done(<pre-edit document>), got \(vm.generationState)")
        }
    }

    func testOversizedDocumentRefusesRevisionWithoutSending() {
        let vm = GenerationViewModel()
        let oversized = String(repeating: "a", count: 50_001) // one over the mirrored server cap
        vm.editedContent = oversized
        vm.editPrompt = "Shorten this"

        vm.applyEdit(api: failingAPI())

        // Refused synchronously — never even reaches .generating, so there's
        // no truncated round-trip to silently overwrite the original with.
        XCTAssertFalse(vm.isBusy)
        XCTAssertEqual(vm.editedContent, oversized)
        XCTAssertNotNil(vm.editError)
        XCTAssertTrue(vm.editError?.contains("50000") == true,
                     "the message should name the exact limit; got: \(vm.editError ?? "nil")")
    }
}
