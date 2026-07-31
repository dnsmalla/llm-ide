import XCTest
@testable import LlmIdeMacLib

final class NoteTypeTests: XCTestCase {
    func testLegacyConstantsStillEqualTheirRawValues() {
        XCTAssertEqual(NoteType.meeting.rawValue, "meeting")
        XCTAssertEqual(NoteType.email.rawValue, "email")
        XCTAssertEqual(NoteType.document.rawValue, "document")
    }

    func testNewTypeConstructibleFromArbitraryString() {
        let slack = NoteType(rawValue: "slack")
        XCTAssertEqual(slack.rawValue, "slack")
        XCTAssertEqual(NoteType("slack"), slack)
    }

    func testLegacyDirectoryNamesPreserved() {
        XCTAssertEqual(NoteType.meeting.directoryName, "meetings")
        XCTAssertEqual(NoteType.email.directoryName, "emails")
        XCTAssertEqual(NoteType.document.directoryName, "documents")
        XCTAssertEqual(NoteType(rawValue: "slack").directoryName, "slack")
    }

    func testCodableRoundTripsArbitraryType() throws {
        let original = NoteType(rawValue: "slack")
        let encoded = try JSONEncoder().encode(original)
        XCTAssertEqual(String(data: encoded, encoding: .utf8), #""slack""#)
        let decoded = try JSONDecoder().decode(NoteType.self, from: encoded)
        XCTAssertEqual(decoded, original)
    }
}
