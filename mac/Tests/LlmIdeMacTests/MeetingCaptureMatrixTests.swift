import XCTest
@testable import LlmIdeMacLib

final class MeetingCaptureMatrixTests: XCTestCase {
    func testNativeCaptureLimitedToDesktopScrapers() {
        let advertised = Set(MeetingCaptureMatrix.platforms.compactMap(\.nativeSourceRawValue))
        let implemented = Set(PlatformDetector.allScrapers.map(\.source.rawValue))
        XCTAssertEqual(advertised, implemented)
    }

    /// The matrix lives in Core and spells native sources as wire literals
    /// (Core may not name Live's `CaptureSource`); this keeps those literals
    /// tied to the real enum.
    func testNativeSourcesAreValidCaptureSources() {
        for raw in MeetingCaptureMatrix.platforms.compactMap(\.nativeSourceRawValue) {
            XCTAssertNotNil(CaptureSource(rawValue: raw), "unknown capture source \(raw)")
        }
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
