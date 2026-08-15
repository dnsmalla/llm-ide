import XCTest
@testable import LlmIdeMacLib

final class ChatSlashCommandsTests: XCTestCase {
    func testRecognizesClearAndItsDocumentedAliases() {
        XCTAssertTrue(ChatSlashCommands.isClearCommand("/clear"))
        XCTAssertTrue(ChatSlashCommands.isClearCommand("/reset"))
        XCTAssertTrue(ChatSlashCommands.isClearCommand("/new"))
    }

    func testCaseInsensitiveAndToleratesSurroundingWhitespace() {
        XCTAssertTrue(ChatSlashCommands.isClearCommand("/CLEAR"))
        XCTAssertTrue(ChatSlashCommands.isClearCommand("  /clear  "))
    }

    func testDoesNotMatchOrdinaryMessagesIncludingOnesStartingWithClear() {
        XCTAssertFalse(ChatSlashCommands.isClearCommand("clear"))
        XCTAssertFalse(ChatSlashCommands.isClearCommand("/clearly not a command"))
        XCTAssertFalse(ChatSlashCommands.isClearCommand("/clear the table for me"))
        XCTAssertFalse(ChatSlashCommands.isClearCommand(""))
        XCTAssertFalse(ChatSlashCommands.isClearCommand("/model"))
    }

    // MARK: - sectionCommand

    func testSectionCommandRecognizesConfigSettingsAliases() {
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/config"), .settings)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/settings"), .settings)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/SETTINGS"), .settings)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("  /config  "), .settings)
    }

    func testSectionCommandMapsLoopMcpPluginAgents() {
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/loop"), .loopEngine)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/mcp"), .library)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/plugin"), .library)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/plugins"), .library)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/agents"), .library)
    }

    func testSectionCommandReturnsNilForUnrecognizedOrOrdinaryText() {
        XCTAssertNil(ChatSlashCommands.sectionCommand("/clear"))
        XCTAssertNil(ChatSlashCommands.sectionCommand("/model"))
        XCTAssertNil(ChatSlashCommands.sectionCommand("open the settings please"))
        XCTAssertNil(ChatSlashCommands.sectionCommand(""))
    }

    // MARK: - modelArgument

    func testModelArgumentExtractsTheArgumentAfterModel() {
        XCTAssertEqual(ChatSlashCommands.modelArgument("/model sonnet"), "sonnet")
        XCTAssertEqual(ChatSlashCommands.modelArgument("/model  gpt-5  "), "gpt-5")
        XCTAssertEqual(ChatSlashCommands.modelArgument("/MODEL Sonnet"), "Sonnet")
    }

    func testModelArgumentIsEmptyStringForBareModelCommand() {
        XCTAssertEqual(ChatSlashCommands.modelArgument("/model"), "")
        XCTAssertEqual(ChatSlashCommands.modelArgument("  /model  "), "")
    }

    func testModelArgumentReturnsNilForNonModelText() {
        XCTAssertNil(ChatSlashCommands.modelArgument("/models"))
        XCTAssertNil(ChatSlashCommands.modelArgument("please switch the model"))
        XCTAssertNil(ChatSlashCommands.modelArgument(""))
    }
}
