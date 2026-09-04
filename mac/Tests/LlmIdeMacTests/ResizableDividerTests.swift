import XCTest
@testable import LlmIdeMacLib

final class ResizableDividerTests: XCTestCase {

    func testClampPassesThroughAValueInRange() {
        XCTAssertEqual(ResizableDivider.clamp(300, minWidth: 160, maxWidth: 520), 300)
    }

    func testClampPinsBelowMinimum() {
        XCTAssertEqual(ResizableDivider.clamp(40, minWidth: 160, maxWidth: 520), 160)
    }

    func testClampPinsAboveMaximum() {
        XCTAssertEqual(ResizableDivider.clamp(9000, minWidth: 160, maxWidth: 520), 520)
    }

    func testClampHandlesNegativeDragOvershoot() {
        XCTAssertEqual(ResizableDivider.clamp(-500, minWidth: 160, maxWidth: 520), 160)
    }

    /// A window narrower than `minWidth` can produce maxWidth < minWidth.
    /// Minimum must win — returning a value below `minWidth` would collapse
    /// the tree to an unusable sliver with no way to drag it back.
    func testClampPrefersMinimumWhenBoundsAreInverted() {
        XCTAssertEqual(ResizableDivider.clamp(300, minWidth: 400, maxWidth: 200), 400)
    }

    /// The bounds are inclusive — dragging exactly to an edge must not be
    /// nudged off it, or the width would jitter at the limits.
    func testClampIsInclusiveAtBothEdges() {
        XCTAssertEqual(ResizableDivider.clamp(160, minWidth: 160, maxWidth: 520), 160)
        XCTAssertEqual(ResizableDivider.clamp(520, minWidth: 160, maxWidth: 520), 520)
    }

    /// A NaN drag translation must not become the stored width: `@AppStorage`
    /// would persist it and every later render would produce a NaN frame.
    func testClampNeverReturnsNaN() {
        XCTAssertFalse(ResizableDivider.clamp(.nan, minWidth: 160, maxWidth: 520).isNaN)
    }
}
