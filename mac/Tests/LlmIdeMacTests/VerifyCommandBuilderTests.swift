import XCTest
@testable import LlmIdeMacLib

final class VerifyCommandBuilderTests: XCTestCase {
    func testForms() {
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .xctest, testId: "LlmIdeMacTests.FooTests/testBar", packageDir: "mac", fallback: "x"), "cd mac && swift test --filter 'FooTests/testBar'")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .pytest, testId: "tests/test_x.py::test_a", packageDir: "", fallback: "x"), "pytest 'tests/test_x.py::test_a'")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .goTest, testId: "TestAdds", packageDir: "svc", fallback: "x"), "cd svc && go test ./... -run '^TestAdds$'")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .make, testId: "anything", packageDir: "", fallback: "make test"), "make test")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .jest, testId: "it's", packageDir: "", fallback: "x"), "npx jest -t 'it'\\''s'")
    }
}
