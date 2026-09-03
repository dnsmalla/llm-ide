import XCTest
@testable import LlmIdeMacLib

final class MonacoHostHTMLTests: XCTestCase {
    func testMonacoIndexHTMLIsBundled() throws {
        // Unlike Hljs.bundled (Bundle.main only — silently empty under
        // `swift test`, see SourceConnectorManifestTests.swift's comment),
        // MonacoHost.indexURL() must resolve here too: it also checks the
        // SwiftPM resource bundle by URL, the same way
        // SourceConnectorManifest.bundledResourceDirectories() does.
        let url = MonacoHost.indexURL()
        XCTAssertNotNil(url, "Resources/monaco/index.html must be bundled — did Task 11's Package.swift edit land?")
    }

    func testMonacoDirectoryContainsTheLoader() throws {
        guard let indexURL = MonacoHost.indexURL() else {
            return XCTFail("index.html not found")
        }
        let vsLoader = indexURL.deletingLastPathComponent().appendingPathComponent("vs/loader.js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: vsLoader.path),
                      "vs/loader.js must sit alongside index.html for the relative <script src> to resolve")
    }
}
