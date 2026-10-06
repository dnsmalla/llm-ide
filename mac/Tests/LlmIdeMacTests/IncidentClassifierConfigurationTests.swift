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

    @Test func realFailuresStillCount() {
        #expect(IncidentClassifier.environmentalReason(message: "SDK diff failed (exit 2)") == nil)
    }
}
