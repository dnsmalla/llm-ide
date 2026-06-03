import Testing
import Foundation
@testable import MeetNotesMac

@MainActor
struct CodeAssistantSessionTests {
    @Test func normalisesWhitespaceAndCase() {
        let s = CodeAssistantSession()
        let h1 = s.hashForPrompt("  How does AUTH work? ")
        let h2 = s.hashForPrompt("how does auth work")
        #expect(h1 == h2)
    }

    @Test func recordIncrementsCounter() {
        let s = CodeAssistantSession()
        let h = s.record(prompt: "explain auth")
        #expect(s.count(for: h) == 1)
        _ = s.record(prompt: "explain auth")
        _ = s.record(prompt: "explain auth")
        #expect(s.count(for: h) == 3)
    }

    @Test func shouldNudgeFiresAtThresholdAndStaysOnUntilDismissed() {
        let s = CodeAssistantSession()
        let p = "explain auth"
        _ = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == false)
        _ = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == false)
        let h = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == true)

        s.dismiss(hash: h)
        #expect(s.shouldNudge(for: p) == false)
        _ = s.record(prompt: p)
        #expect(s.shouldNudge(for: p) == false)
    }

    @Test func resetClearsCounterAndDismissed() {
        let s = CodeAssistantSession()
        let h = s.record(prompt: "x")
        s.dismiss(hash: h)
        s.reset()
        #expect(s.count(for: h) == 0)
        #expect(s.shouldNudge(for: "x") == false)
        _ = s.record(prompt: "x")
        _ = s.record(prompt: "x")
        _ = s.record(prompt: "x")
        #expect(s.shouldNudge(for: "x") == true)
    }

    @Test func emptyOrWhitespacePromptsAreIgnored() {
        let s = CodeAssistantSession()
        let h = s.record(prompt: "   ")
        #expect(h.isEmpty)
        #expect(s.shouldNudge(for: "   ") == false)
    }
}
