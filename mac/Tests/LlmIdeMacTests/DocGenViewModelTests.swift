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
        vm.isEditing = true
        vm.editedContent = "draft"
        vm.resetToIdle()
        XCTAssertFalse(vm.isEditing)
        XCTAssertEqual(vm.editedContent, "")
    }
}
