import XCTest
@testable import LlmIdeMacLib

/// The live status line and the per-turn step rows are the user-facing
/// replacement for raw `<<<TOOL_CALL>>>` JSON appearing in the reply. They have
/// to read like actions, not like wire names: "Using read-file…" told the user
/// nothing, which is half of why the raw fence looked more informative.
final class AgentProgressLabelTests: XCTestCase {

    func testToolLabelReadsAsAnActionOnTheNamedTarget() {
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "read-file",
                                          detail: "Views/UpdateFileSheet.swift"),
            "Reading Views/UpdateFileSheet.swift…")
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "bash", detail: "npm test"),
            "Running npm test…")
    }

    func testMissingDetailDegradesToTheVerbNotTheWireName() {
        // An older server sends no `detail`. The line must still be a sentence,
        // and must not fall back to exposing the tool id.
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "read-file", detail: nil),
            "Reading…")
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "search-kb", detail: ""),
            "Searching the library…")
    }

    func testAnUnknownToolStillProducesSomethingReadable() {
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "brand-new-tool", detail: "x"),
            "Using brand-new-tool x…")
        XCTAssertEqual(LlmIdeAPIClient.progressLabel(phase: "tool", tool: nil), "Working…")
    }

    func testSdkBuiltinToolNamesReadAsActionsNotWireNames() {
        // The v2 engine reports the SDK's capitalized built-ins. Before
        // normalization these fell through to the default and the transcript
        // showed a column of "Using Bash" / "Using Read".
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "Bash", detail: "swift build"),
            "Running swift build…")
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "Read", detail: "App.swift"),
            "Reading App.swift…")
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "Edit", detail: nil),
            "Editing…")
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "Write", detail: nil),
            "Writing…")
    }

    func testMcpNamespacedToolsResolveToTheirUnderlyingVerb() {
        // mcp__<server>__<tool>: the server segment is an install detail.
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "mcp__llmide__task-update", detail: nil),
            "Planning…")
        XCTAssertEqual(LlmIdeAPIClient.normalizedToolName("mcp__llmide__find-code"), "find-code")
        // An unknown MCP tool still loses the namespace — "Using search" beats
        // "Using mcp__acme__search".
        XCTAssertEqual(
            LlmIdeAPIClient.progressLabel(phase: "tool", tool: "mcp__acme__search", detail: nil),
            "Using search…")
    }

    func testNonToolPhasesKeepTheirOwnWording() {
        XCTAssertEqual(LlmIdeAPIClient.progressLabel(phase: "writing", tool: nil),
                       "Writing the answer…")
        XCTAssertEqual(LlmIdeAPIClient.progressLabel(phase: "thinking", tool: nil), "Thinking…")
        XCTAssertEqual(LlmIdeAPIClient.progressLabel(phase: nil, tool: nil), "Thinking…")
    }

    func testStepIconsDistinguishReadsFromWritesAndShellRuns() {
        let icon = { (tool: String?) in
            ChatMessage.ToolStep(label: "x", tool: tool).icon
        }
        XCTAssertEqual(icon("read-file"), "doc.text")
        XCTAssertEqual(icon("bash"), "terminal")
        XCTAssertEqual(icon("run-bash"), "terminal")
        XCTAssertEqual(icon("update-file"), "pencil")
        XCTAssertEqual(icon("git-op"), "arrow.triangle.branch")
        XCTAssertEqual(icon("web-search"), "globe")
        // An unmapped tool must still render an icon rather than a blank slot.
        XCTAssertFalse(icon("something-new").isEmpty)
        XCTAssertFalse(icon(nil).isEmpty)
    }

    func testProgressEventKnowsWhetherItWasAToolStep() {
        // Only tool phases become durable rows; thinking/writing are momentary.
        let tool = LlmIdeAPIClient.AgentProgress(
            label: "Reading X…", phase: "tool", tool: "read-file", detail: "X")
        let writing = LlmIdeAPIClient.AgentProgress(
            label: "Writing the answer…", phase: "writing", tool: nil, detail: nil)
        XCTAssertTrue(tool.isTool)
        XCTAssertFalse(writing.isTool)
    }
}
