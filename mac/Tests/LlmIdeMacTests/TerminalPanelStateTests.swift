import Testing
@testable import LlmIdeMac

/// The terminal dock's drag-resize is clamped to [120, windowHeight × 0.6]
/// so it can't collapse below a usable height or eat more than 60% of the
/// window. Pure logic — worth pinning since it drives every resize.
@MainActor
struct TerminalPanelStateTests {
    @Test("clamps to [120, 60%] for a normal window")
    func normalWindow() {
        let s = TerminalPanelState()
        // window 800 → ceiling 480
        #expect(s.clampedHeight(50, windowHeight: 800) == 120)   // below the 120 floor
        #expect(s.clampedHeight(300, windowHeight: 800) == 300)  // within range, untouched
        #expect(s.clampedHeight(600, windowHeight: 800) == 480)  // above the 60% ceiling
        #expect(s.clampedHeight(480, windowHeight: 800) == 480)  // exactly the ceiling
        #expect(s.clampedHeight(120, windowHeight: 800) == 120)  // exactly the floor
    }

    @Test("only the 120 floor applies when the window height is unknown")
    func unknownWindow() {
        let s = TerminalPanelState()
        // windowHeight <= 0 is the "not yet measured" sentinel — guard keeps
        // the floor but skips the percentage ceiling.
        #expect(s.clampedHeight(50, windowHeight: 0) == 120)
        #expect(s.clampedHeight(300, windowHeight: 0) == 300)
        #expect(s.clampedHeight(50, windowHeight: -10) == 120)
    }
}
