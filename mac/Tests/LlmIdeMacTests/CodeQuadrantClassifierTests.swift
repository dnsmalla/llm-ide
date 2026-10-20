import XCTest
@testable import LlmIdeMacLib

final class CodeQuadrantClassifierTests: XCTestCase {
    func testSmallFileIsTrivial() {
        XCTAssertEqual(CodeQuadrantClassifier.classify(loc: 20, functionCount: 2, collaborators: 1, role: nil), .trivial)
    }
    func testComplexFewCollaboratorsIsDomainLogic() {
        XCTAssertEqual(CodeQuadrantClassifier.classify(loc: 120, functionCount: 5, collaborators: 2, role: "service"), .domainLogic)
    }
    func testViewRoleIsController() {
        XCTAssertEqual(CodeQuadrantClassifier.classify(loc: 120, functionCount: 5, collaborators: 2, role: "view"), .controller)
    }
    func testComplexManyCollaboratorsIsOverComplex() {
        XCTAssertEqual(CodeQuadrantClassifier.classify(loc: 200, functionCount: 8, collaborators: 9, role: nil), .overComplex)
    }
    func testFiveHundredLinesIsOverComplex() {
        XCTAssertEqual(CodeQuadrantClassifier.classify(loc: 500, functionCount: 1, collaborators: 0, role: nil), .overComplex)
    }
}
