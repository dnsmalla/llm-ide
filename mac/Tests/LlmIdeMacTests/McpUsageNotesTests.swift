import Testing
@testable import LlmIdeMacLib

/// The Library tells the user what an enabled MCP server costs and where it
/// works; these strings are the only place that rule is written down.
@Suite("MCP usage notes")
struct McpUsageNotesTests {
    @Test("none enabled reads as free; some enabled names the count")
    func sectionSummary() {
        #expect(McpUsageNotes.sectionSummary(enabledCount: 0).contains("adds no tokens"))
        #expect(McpUsageNotes.sectionSummary(enabledCount: 1).hasPrefix("1 server enabled"))
        #expect(McpUsageNotes.sectionSummary(enabledCount: 2).hasPrefix("2 servers enabled"))
    }

    @Test("the mode note names every mode that never gets MCP")
    func modeNote() {
        for mode in ["Plan", "Assist Plan", "Review", "Document"] {
            #expect(McpUsageNotes.modeNote.contains(mode), "\(mode) is a restricted mode")
        }
        #expect(McpUsageNotes.modeNote.contains("Ask") && McpUsageNotes.modeNote.contains("Execute"))
    }

    @Test("the cost note says it is per call and tells the user to keep it off")
    func costNote() {
        #expect(McpUsageNotes.costNote.contains("every model call"))
        #expect(McpUsageNotes.costNote.contains("off"))
    }
}
