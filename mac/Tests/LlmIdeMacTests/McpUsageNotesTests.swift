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

    @Test("MCP is Execute-only: every other mode, and the quick-chat surfaces, are named as excluded")
    func modeNote() {
        // `restrictsTools` is true for every mode in MODE_CONFIG, Ask included.
        for mode in ["Plan", "Assist Plan", "Review", "Document", "Ask"] {
            #expect(McpUsageNotes.modeNote.contains(mode), "\(mode) never gets MCP")
        }
        #expect(McpUsageNotes.modeNote.hasPrefix("Available in Execute mode only"),
                "Ask must not be offered as a place MCP works")
        for surface in ["menu bar", "chat sheet", "phone"] {
            #expect(McpUsageNotes.modeNote.contains(surface))
        }
        #expect(!McpUsageNotes.sectionSummary(enabledCount: 1).contains("Ask"))
    }

    @Test("the cost note says it is per call and tells the user to keep it off")
    func costNote() {
        #expect(McpUsageNotes.costNote.contains("every model call"))
        #expect(McpUsageNotes.costNote.contains("off"))
    }
}
