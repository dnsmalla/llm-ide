import Testing
@testable import LlmIdeMacLib

@Suite("Incident classifier: loop configuration errors")
struct IncidentClassifierConfigurationTests {
    @Test func misconfiguredStagesAreNotAppBugs() {
        for message in ["Stage \"Test\" has no runnable command",
                        "Stage \"Review\" has no skill chosen",
                        "Stage \"Check\" has no checks configured",
                        "This loop needs a newer version of LLM-IDE"] {
            #expect(IncidentClassifier.environmentalReason(message: message) == "configuration", Comment(rawValue: message))
        }
    }

    /// The Refactoring loop's `.error` endings are verdicts, not app incidents.
    @Test func refactorLoopVerdictsAreNotAppBugs() {
        for message in ["stage Test Baseline failed and does not allow repair",
                        "batch R2 promised filesOver500Count to fall; it did not",
                        "structure regressed: cycleCount, filesOver500Count",
                        "graph not regenerated (a code-graph scan is already running); batch R2 not verified"] {
            #expect(IncidentClassifier.environmentalReason(message: message) == "refactor loop", Comment(rawValue: message))
        }
    }

    @Test func realFailuresStillCount() {
        #expect(IncidentClassifier.environmentalReason(message: "SDK diff failed (exit 2)") == nil)
    }
}
