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

    expect(CodeQuadrantClassifier.classify(loc: 20, functionCount: 2, collaborators: 1, role: nil) == .trivial,
           "small file is trivial")
    expect(CodeQuadrantClassifier.classify(loc: 120, functionCount: 5, collaborators: 2, role: "service") == .domainLogic,
           "complex file with few collaborators is domain logic")
    expect(CodeQuadrantClassifier.classify(loc: 120, functionCount: 5, collaborators: 2, role: "view") == .controller,
           "view role is a controller")
    expect(CodeQuadrantClassifier.classify(loc: 200, functionCount: 8, collaborators: 9, role: nil) == .overComplex,
           "complex file with many collaborators is over-complex")
    expect(CodeQuadrantClassifier.classify(loc: 500, functionCount: 1, collaborators: 0, role: nil) == .overComplex,
           "500-line file is over-complex")
}

#endif
