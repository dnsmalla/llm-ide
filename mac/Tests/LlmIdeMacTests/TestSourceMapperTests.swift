import XCTest
@testable import LlmIdeMacLib

final class TestSourceMapperTests: XCTestCase {
    func testSwiftRules() {
        XCTAssertTrue(TestSourceMapper.isTestPath("mac/Tests/LlmIdeMacTests/FooBarTests.swift"))
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "mac/Tests/LlmIdeMacTests/FooBarTests.swift"), "FooBar")
        XCTAssertEqual(TestSourceMapper.sourceStem(forSourcePath: "mac/Sources/A/FooBar+History.swift"), "FooBar")
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "mac/Sources/A/FooBar.swift"), "FooBarTests.swift")
    }
    func testOtherLanguages() {
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "extension/tests/vault.test.mjs"), "vault")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "src/__tests__/widget.tsx"), "widget")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "pkg/test_parser.py"), "parser")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "pkg/parser_test.go"), "parser")
        XCTAssertNil(TestSourceMapper.sourceStem(forTestPath: "src/widget.tsx"))
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "extension/kb/db.mjs"), "db.test.mjs")
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "pkg/parser.py"), "test_parser.py")
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "pkg/parser.go"), "parser_test.go")
        XCTAssertNil(TestSourceMapper.testFileName(forSourcePath: "README.md"))
    }
    func testSourceCandidate() {
        XCTAssertTrue(TestSourceMapper.isSourceCandidate("extension/kb/db.mjs"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("extension/tests/db.test.mjs"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("mac/Package.swift"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("node_modules/x/index.js"))
    }
    func testMarkers() {
        for s in ["final class A: XCTestCase { func testX() {} }", "@Test func parses() {}", "test('adds', () => {})",
                  "it('adds', () => {})", "def test_adds():", "func TestAdds(t *testing.T) {"] {
            XCTAssertTrue(TestSourceMapper.containsTestMarker(s), s)
        }
        XCTAssertFalse(TestSourceMapper.containsTestMarker("// placeholder"))
    }
}
