import Testing
import Foundation
@testable import LlmIdeMacLib

/// F6 #4: Execute's plan body is the card's own text or ITS plan file —
/// never a guessed attachment like an unrelated README.md.
@MainActor
@Suite("Plan execute content")
struct PlanContentForExecuteTests {
    typealias A = LlmIdeAPIClient.CodeAttachment

    private func payload(url: String?, content: String? = nil) -> ChatMessage.ToolResultPayload {
        ChatMessage.ToolResultPayload(kind: .plan, summary: "plan", exitCode: nil, command: nil,
                                      output: nil, url: url, planTitle: "P", planContent: content)
    }

    @Test("the card's own plan text wins")
    func cardText() {
        let got = CodeAssistantPanel.planContentForExecute(
            payload: payload(url: "llm-doc/plans/a.md", content: "1. x"),
            attachments: [A(path: "README.md", content: "readme")])
        #expect(got == "1. x")
    }

    @Test("a named plan file never falls back to another markdown file")
    func namedFileNoGuess() {
        let got = CodeAssistantPanel.planContentForExecute(
            payload: payload(url: "llm-doc/plans/2026-09-25-auth.md"),
            attachments: [A(path: "README.md", content: "readme"),
                          A(path: "docs/myplan-2026-09-25-auth.md", content: "other")])
        #expect(got == "", "no suffix match, no README")
    }

    @Test("a named plan file matches by exact path or file name")
    func namedFileMatches() {
        let atts = [A(path: "README.md", content: "readme"),
                    A(path: "~/proj/llm-doc/plans/auth.md", content: "1. plan")]
        #expect(CodeAssistantPanel.planContentForExecute(
            payload: payload(url: "llm-doc/plans/auth.md"), attachments: atts) == "1. plan")
    }

    @Test("with no named file, only a single plan-like markdown attachment is used")
    func unnamedFallback() {
        #expect(CodeAssistantPanel.planContentForExecute(
            payload: payload(url: nil),
            attachments: [A(path: "README.md", content: "readme")]) == "")
        #expect(CodeAssistantPanel.planContentForExecute(
            payload: payload(url: nil),
            attachments: [A(path: "README.md", content: "readme"),
                          A(path: "llm-doc/plans/x.md", content: "1. x")]) == "1. x")
        #expect(CodeAssistantPanel.planContentForExecute(
            payload: payload(url: nil),
            attachments: [A(path: "llm-doc/plans/x.md", content: "1. x"),
                          A(path: "llm-doc/plans/y.md", content: "1. y")]) == "", "ambiguous")
    }
}
