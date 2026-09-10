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

    func testSectionCommandMapsLoopMcpPluginAgentsHooks() {
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/loop"), .loopEngine)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/mcp"), .library)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/plugin"), .library)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/plugins"), .library)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/agents"), .library)
        XCTAssertEqual(ChatSlashCommands.sectionCommand("/hooks"), .library)
    }

    // MARK: - builtins ("/" menu catalog)

    /// Every row the "/" menu shows must resolve to a REAL action when
    /// accepted and submitted — a menu entry that silently falls through to
    /// the model as a prompt is exactly the drift the shared catalog exists
    /// to prevent.
    func testEveryBuiltinMenuEntryResolvesToARealAction() {
        for b in ChatSlashCommands.builtins {
            let submitted = b.insert.trimmingCharacters(in: .whitespaces)
            let hasAction = ChatSlashCommands.isClearCommand(submitted)
                || ChatSlashCommands.sectionCommand(submitted) != nil
                || ChatSlashCommands.modelArgument(submitted) != nil
            XCTAssertTrue(hasAction, "\(b.label) is listed in the menu but has no client-side action")
        }
    }

    func testBuiltinLabelsAreSlashPrefixedAndUnique() {
        let labels = ChatSlashCommands.builtins.map(\.label)
        XCTAssertEqual(labels.count, Set(labels).count, "duplicate builtin labels")
        for label in labels {
            XCTAssertTrue(label.hasPrefix("/"), "\(label) missing leading slash")
        }
    }

    func testBuiltinsIncludeTheFullDiscoverabilitySet() {
        let labels = Set(ChatSlashCommands.builtins.map(\.label))
        for expected in ["/clear", "/model", "/config", "/loop", "/mcp", "/plugin", "/agents", "/hooks"] {
            XCTAssertTrue(labels.contains(expected), "missing \(expected)")
        }
    }

    /// The recognizers are DERIVED from the catalog, so every declared alias
    /// must resolve to the same action as its canonical label — and the menu
    /// detail must advertise exactly the declared aliases, not a hand-written
    /// restatement.
    func testEveryAliasResolvesToTheSameActionAsItsCanonicalLabel() {
        for b in ChatSlashCommands.builtins {
            for alias in b.aliases {
                XCTAssertEqual(ChatSlashCommands.isClearCommand(alias),
                               ChatSlashCommands.isClearCommand(b.label),
                               "\(alias) diverges from \(b.label) on clear")
                XCTAssertEqual(ChatSlashCommands.sectionCommand(alias),
                               ChatSlashCommands.sectionCommand(b.label),
                               "\(alias) diverges from \(b.label) on section")
                XCTAssertTrue(b.detail.contains(alias),
                              "\(b.label)'s detail doesn't advertise \(alias)")
            }
        }
    }

    func testReservedNamesCoverEveryLabelAndAlias() {
        for b in ChatSlashCommands.builtins {
            for name in [b.label] + b.aliases {
                XCTAssertTrue(ChatSlashCommands.reservedNames.contains(name.lowercased()),
                              "\(name) missing from reservedNames")
            }
        }
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
