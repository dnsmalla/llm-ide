import Testing
@testable import LlmIdeMac

@Suite("AICliTool")
struct AICliToolTests {

    @Test func claudeCodeExecutable() {
        #expect(AICliTool.claudeCode.cliExecutable == "claude")
    }

    @Test func cursorExecutable() {
        #expect(AICliTool.cursor.cliExecutable == "cursor")
    }

    @Test func copilotExecutable() {
        #expect(AICliTool.copilot.cliExecutable == "gh copilot")
    }

    @Test func geminiExecutable() {
        #expect(AICliTool.gemini.cliExecutable == "gemini")
    }
}
