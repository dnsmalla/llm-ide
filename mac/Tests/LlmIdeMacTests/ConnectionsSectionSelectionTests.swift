import XCTest
@testable import LlmIdeMacLib

/// The Settings Connections section's card visibility rule: Meeting and
/// Email are fixed defaults; everything else appears only when selected.
final class ConnectionsSectionSelectionTests: XCTestCase {
    func testDefaultsAreAlwaysPresentAndUnselectable() {
        // No selection at all (e.g. catalog request failed): defaults stay.
        let ids = ConnectionsSelection.visibleCardIds(selected: [])
        XCTAssertEqual(ids.first, "meetings")
        XCTAssertTrue(ids.contains("email"))
        XCTAssertFalse(ids.contains("slack"))
        XCTAssertFalse(ids.contains("box"))
    }

    func testSelectedConnectorsAppearInCatalogOrder() {
        let ids = ConnectionsSelection.visibleCardIds(selected: ["slack", "miro", "box"])
        XCTAssertEqual(ids, ["meetings", "email", "miro", "box", "slack"])
    }

    func testUnknownIdsAreIgnored() {
        // A connector removed from the catalog must not leak into the section.
        let ids = ConnectionsSelection.visibleCardIds(selected: ["retired-one", "box"])
        XCTAssertEqual(ids, ["meetings", "email", "box"])
    }
}
