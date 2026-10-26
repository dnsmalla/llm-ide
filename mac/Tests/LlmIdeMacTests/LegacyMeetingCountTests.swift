import XCTest
@testable import LlmIdeMacLib

/// `legacyMeetingCount` reads the meeting total from `GET /kb/stats`. The
/// server answers a top-level `meetings`; the body below is the captured
/// fixture schema/http/fixtures/kb-sources/get-kb-stats-200.json.
final class LegacyMeetingCountTests: XCTestCase {
    private let statsBody = #"""
    {
      "meetings": 1,
      "entities": 1,
      "sources": {
        "code": 1,
        "ticket": 2,
        "qa": 2,
        "lastIndexed": {
          "code": "2026-10-26 05:27:17",
          "qa": "2026-10-26 05:32:07",
          "ticket": "2026-10-26 05:34:34"
        }
      },
      "plans": 0,
      "tasks": 0,
      "reviews": {"pending": 0, "approved": 0, "rejected": 0, "executed": 0, "failed": 0, "expired": 0},
      "outcomes": {"total": 0, "byState": {}}
    }
    """#

    func testDecodesTopLevelMeetingsFromRealStatsBody() throws {
        let body = try JSONDecoder().decode(
            LlmIdeAPIClient.LegacyStatsBody.self, from: Data(statsBody.utf8))
        XCTAssertEqual(body.meetingCount, 1)
    }

    func testAcceptsLegacyTotalsShape() throws {
        let legacy = #"{"totals": {"meetings": 7}}"#
        let body = try JSONDecoder().decode(
            LlmIdeAPIClient.LegacyStatsBody.self, from: Data(legacy.utf8))
        XCTAssertEqual(body.meetingCount, 7)
    }

    func testMissingCountIsZero() throws {
        let body = try JSONDecoder().decode(
            LlmIdeAPIClient.LegacyStatsBody.self, from: Data("{}".utf8))
        XCTAssertEqual(body.meetingCount, 0)
    }
}
