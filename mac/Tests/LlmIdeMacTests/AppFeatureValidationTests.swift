import XCTest
@testable import LlmIdeMacLib

final class AppFeatureValidationTests: XCTestCase {
    func testValidatedKeepsIndependentFeatures() {
        let input: Set<AppFeature> = [.agentChat, .terminal, .autoTasks]
        XCTAssertEqual(AppFeature.validated(input), input)
    }

    func testValidatedDropsDependentWithoutDependency() {
        let input: Set<AppFeature> = [.codeGraph3D]
        XCTAssertEqual(AppFeature.validated(input), [])
    }

    func testValidatedDropsDependentWhenDependencyRemoved() {
        let input: Set<AppFeature> = [.fileExplorer, .codeGraph3D, .ganttIssues, .docGen, .agentChat]
        let withoutExplorer: Set<AppFeature> = input.subtracting([.fileExplorer])
        XCTAssertEqual(
            AppFeature.validated(withoutExplorer),
            [.agentChat]
        )
    }

    func testValidatedIsStableWhenAlreadyConsistent() {
        let input: Set<AppFeature> = [.fileExplorer, .codeGraph3D, .terminal]
        XCTAssertEqual(AppFeature.validated(input), input)
    }
}
