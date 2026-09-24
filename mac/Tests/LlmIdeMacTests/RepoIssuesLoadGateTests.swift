import Testing
@testable import LlmIdeMacLib

/// A slow issues load for project A must not land under project B.
@Suite("RepoIssuesView load gate")
struct RepoIssuesLoadGateTests {
    @Test("Only the latest load for the still-selected project applies")
    func gate() {
        #expect(RepoIssuesView.shouldApply(loadGeneration: 3, currentGeneration: 3, loadedProject: "A", selectedProject: "A"))
        // Superseded by a newer load (filter change / project switch).
        #expect(!RepoIssuesView.shouldApply(loadGeneration: 2, currentGeneration: 3, loadedProject: "A", selectedProject: "A"))
        // Same generation but the user moved to another project meanwhile.
        #expect(!RepoIssuesView.shouldApply(loadGeneration: 3, currentGeneration: 3, loadedProject: "A", selectedProject: "B"))
        #expect(!RepoIssuesView.shouldApply(loadGeneration: 3, currentGeneration: 3, loadedProject: "A", selectedProject: nil))
    }
}
