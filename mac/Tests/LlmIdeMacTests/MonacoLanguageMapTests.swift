import XCTest
@testable import LlmIdeMacLib

final class MonacoLanguageMapTests: XCTestCase {
    func testKnownExtensionsMapToTheirMonacoLanguageId() {
        let cases: [String: String] = [
            "swift": "swift",
            "md": "markdown", "markdown": "markdown",
            "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
            "ts": "typescript", "tsx": "typescript",
            "py": "python",
            "sql": "sql",
            "sh": "shell", "bash": "shell", "zsh": "shell",
            "yml": "yaml", "yaml": "yaml",
            "html": "html", "htm": "html",
            "css": "css",
        ]
        for (ext, expected) in cases {
            XCTAssertEqual(MonacoLanguageMap.id(for: ext), expected, "extension \"\(ext)\"")
        }
    }

    func testUppercaseExtensionNormalizesLikeLowercase() {
        XCTAssertEqual(MonacoLanguageMap.id(for: "SWIFT"), "swift")
        XCTAssertEqual(MonacoLanguageMap.id(for: "Py"), "python")
    }

    func testUnsupportedExtensionsFallBackToPlaintext() {
        // json specifically: Monaco has never shipped a basic-languages
        // tokenizer for it (confirmed against the vendored package in P0) —
        // this is not an oversight, it must stay plaintext.
        for ext in ["json", "rb", "go", "rs", "toml", "xml", "unknownext", ""] {
            XCTAssertEqual(MonacoLanguageMap.id(for: ext), "plaintext", "extension \"\(ext)\"")
        }
    }
}
