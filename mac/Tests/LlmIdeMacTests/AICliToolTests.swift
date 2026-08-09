import XCTest
@testable import LlmIdeMacLib

/// `AICliTool.nonInteractivePromptArgs(_:)` — per-tool argument mapping for
/// unattended auto-task invocation (the spawn previously appended `-p`
/// unconditionally, which is Claude-only).
final class AICliToolTests: XCTestCase {
    func testClaudeUsesDashP() {
        XCTAssertEqual(AICliTool.claudeCode.nonInteractivePromptArgs("do X"), ["-p", "do X"])
    }

    func testCodexUsesExecYolo() {
        // codex exec --yolo <prompt>  (--yolo = --dangerously-bypass-approvals-and-sandbox)
        XCTAssertEqual(AICliTool.openai.nonInteractivePromptArgs("do X"), ["exec", "--yolo", "do X"])
    }

    func testGeminiUsesYoloDashP() {
        // --yolo auto-approves tool calls; -p passes the prompt.
        XCTAssertEqual(AICliTool.gemini.nonInteractivePromptArgs("do X"), ["--yolo", "-p", "do X"])
    }

    func testInteractiveEditorsUnsupported() {
        XCTAssertNil(AICliTool.copilot.nonInteractivePromptArgs("do X"))
        XCTAssertNil(AICliTool.cursor.nonInteractivePromptArgs("do X"))
    }

    func testNoCLIToolsUnsupported() {
        XCTAssertNil(AICliTool.deepseek.nonInteractivePromptArgs("do X"))
        XCTAssertNil(AICliTool.glm.nonInteractivePromptArgs("do X"))
        XCTAssertNil(AICliTool.custom.nonInteractivePromptArgs("do X"))
    }
}
