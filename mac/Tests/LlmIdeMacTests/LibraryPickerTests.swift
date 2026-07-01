import XCTest
@testable import LlmIdeMac

/// LibraryPicker.filter is the pure selection core: it keeps only items whose
/// category is in the consumer's allowed set, so each panel sees only relevant
/// Library content.
final class LibraryPickerTests: XCTestCase {

    // Module-qualify: the macOS SDK's DeveloperToolsSupport (pulled in
    // transitively via SwiftUI) also exports a `LibraryItem`, so the bare name
    // is ambiguous in the test module. Pin it to the app's own type.
    private func item(_ name: String, _ cat: LlmIdeMac.LibraryItem.Category) -> LlmIdeMac.LibraryItem {
        LlmIdeMac.LibraryItem(name: name, path: "/p/\(name)", category: cat)
    }

    func testFilterKeepsOnlyAllowedCategories() {
        let items = [
            item("a.swift", .code),
            item("note.md", .notes),
            item("data.csv", .data),
            item("call.md", .meetings),
        ]
        let result = LibraryPicker.filter(items, allowed: [.code, .notes])
        XCTAssertEqual(result.map(\.name), ["a.swift", "note.md"])
    }

    func testFilterEmptyWhenNoMatches() {
        let items = [item("a.swift", .code)]
        XCTAssertTrue(LibraryPicker.filter(items, allowed: [.data]).isEmpty)
    }
}
