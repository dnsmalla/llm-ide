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
}
