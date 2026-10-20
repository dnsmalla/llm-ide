import Foundation
import LlmIdeMacLib

#if FEATURE_AUTOTASK

// Asserts the Test loop's alignment with the company test guideline.

func runTestStandardChecks() {
    print("test standard")

    let stalled = TestMapCheck.mapCheckOutcome(delta: ["untestedFunctions": 0], writerChanged: true)
    expect(stalled.passed, "map check passes when the untested count did not fall")
    expect(stalled.note?.contains("advisory") == true, "map check notes the stall as advisory")

    let idle = TestMapCheck.mapCheckOutcome(delta: [:], writerChanged: false)
    expect(idle.passed, "map check passes when the writer covered nothing")
    expect(idle.note == nil, "map check has no note when the writer changed nothing")
}

#endif
