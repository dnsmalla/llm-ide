import XCTest
@testable import LlmIdeMacLib

final class MeetingCaptureMatrixTests: XCTestCase {
    func testNativeCaptureLimitedToDesktopScrapers() {
        let advertised = Set(MeetingCaptureMatrix.platforms.compactMap(\.nativeSourceRawValue))
        let implemented = Set(PlatformDetector.allScrapers.map(\.source.rawValue))
        XCTAssertEqual(advertised, implemented)
    }

    func testMeetIsExtensionOnly() {
        let meet = MeetingCaptureMatrix.platforms.first { $0.id == "meet" }
        XCTAssertEqual(meet?.nativeMac, false)
        XCTAssertEqual(meet?.chromeExtension, true)
    }

    func testConnectionsSubtitleDoesNotImplyNativeMeet() {
        XCTAssertFalse(MeetingCaptureMatrix.connectionsSubtitle.localizedCaseInsensitiveContains("Meet · Teams · Zoom"))
        XCTAssertTrue(MeetingCaptureMatrix.connectionsSubtitle.localizedCaseInsensitiveContains("extension"))
    }
}
