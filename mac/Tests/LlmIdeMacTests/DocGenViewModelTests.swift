import XCTest
@testable import LlmIdeMac

@MainActor
final class DocGenViewModelTests: XCTestCase {

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
        let vm = DocGenViewModel()
        vm.selectedTemplate = makeTemplate()
        XCTAssertFalse(vm.canGenerate)
    }

    func testCannotGenerateWithoutTemplateOrCommand() {
        let vm = DocGenViewModel()
        vm.selectedSources = [makeSource()]
        XCTAssertFalse(vm.canGenerate)
    }

    func testCommandAloneIsEnough() {
        let vm = DocGenViewModel()
        vm.selectedSources = [makeSource()]
        vm.selectedCommand = makeCommand()
        XCTAssertTrue(vm.canGenerate)
    }

    func testTemplateAloneIsEnough() {
        let vm = DocGenViewModel()
        vm.selectedSources = [makeSource()]
        vm.selectedTemplate = makeTemplate()
        XCTAssertTrue(vm.canGenerate)
    }

    func testOutputFilenamePrefersTemplateThenCommand() {
        let vm = DocGenViewModel()
        XCTAssertEqual(vm.outputFilename, "generated-doc")
        vm.selectedCommand = makeCommand()
        XCTAssertEqual(vm.outputFilename, "Summarize-doc")
        vm.selectedTemplate = makeTemplate()
        XCTAssertEqual(vm.outputFilename, "Sprint Review-doc")
    }

    func testResetClearsEditState() {
        let vm = DocGenViewModel()
        vm.editPrompt = "make it shorter"
        vm.editedContent = "draft"
        vm.resetToIdle()
        XCTAssertEqual(vm.editPrompt, "")
        XCTAssertEqual(vm.editedContent, "")
    }

    func testResetClearsSavedFlag() {
        let vm = DocGenViewModel()
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
        let vm = DocGenViewModel()
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        XCTAssertFalse(vm.isBusy)
        vm.selectedSources = [makeSource()]
        vm.selectedTemplate = makeTemplate()
        vm.generate(api: api)
        XCTAssertTrue(vm.isBusy)
        vm.cancelGeneration()
        XCTAssertFalse(vm.isBusy)
    }
}
