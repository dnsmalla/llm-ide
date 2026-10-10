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
    func testNodeLeafAndEscaping() {
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .nodeTest, testId: "suite/adds numbers", packageDir: "extension", fallback: "x"), "cd extension && node --test --test-name-pattern '^adds numbers$' tests/")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .jest, testId: "a.b (c)", packageDir: "", fallback: "x"), "npx jest -t 'a\\.b \\(c\\)'")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .xctest, testId: "M.Foo/test[1]", packageDir: "", fallback: "x"), "swift test --filter 'Foo/test\\[1\\]'")
    }
}
