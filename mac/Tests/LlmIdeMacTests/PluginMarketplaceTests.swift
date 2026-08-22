// Marketplace manifest parsing. A marketplace is someone else's repo, so what
// it may point at is bounded here: paths inside the clone only — never another
// repository, never outside the tree.
import XCTest
@testable import LlmIdeMacLib

final class PluginMarketplaceTests: XCTestCase {
    private func parse(_ json: String) throws -> PluginMarketplace.Parsed {
        try PluginMarketplace.parse(data: json.data(using: .utf8)!)
    }

    func testParsesEntriesWithExplicitSources() throws {
        let parsed = try parse("""
        {"name":"official","plugins":[
          {"name":"code-review","source":"./plugins/code-review","description":"Reviews","version":"1.2.0"},
          {"name":"frontend","source":"plugins/frontend"}
        ]}
        """)
        XCTAssertEqual(parsed.name, "official")
        XCTAssertEqual(parsed.entries.count, 2)
        XCTAssertEqual(parsed.entries[0].relativePath, "plugins/code-review")
        XCTAssertEqual(parsed.entries[0].version, "1.2.0")
        XCTAssertEqual(parsed.entries[1].relativePath, "plugins/frontend")
        XCTAssertNil(parsed.entries[1].version)
        XCTAssertTrue(parsed.skipped.isEmpty)
    }

    func testOmittedSourceFallsBackToTheConventionalPath() throws {
        let parsed = try parse("""
        {"name":"m","plugins":[{"name":"solo","description":"d"}]}
        """)
        XCTAssertEqual(parsed.entries.first?.relativePath, "plugins/solo")
    }

    func testAnotherRepositoryIsSkippedWithAReason() throws {
        let parsed = try parse("""
        {"name":"m","plugins":[
          {"name":"remote","source":"https://github.com/someone/plugin"},
          {"name":"ssh","source":"git@github.com:someone/plugin.git"}
        ]}
        """)
        XCTAssertTrue(parsed.entries.isEmpty)
        XCTAssertEqual(parsed.skipped.count, 2)
        XCTAssertTrue(parsed.skipped.allSatisfy { $0.contains("another repository") })
    }

    func testEscapingPathsAreRefused() throws {
        let parsed = try parse("""
        {"name":"m","plugins":[
          {"name":"up","source":"../../etc"},
          {"name":"abs","source":"/etc/passwd"}
        ]}
        """)
        XCTAssertTrue(parsed.entries.isEmpty)
        XCTAssertEqual(parsed.skipped.count, 2)
        XCTAssertTrue(parsed.skipped.allSatisfy { $0.contains("escapes the repository") })
    }

    func testNamelessEntryIsSkipped() throws {
        let parsed = try parse("""
        {"name":"m","plugins":[{"source":"./plugins/x"},{"name":"ok","source":"./plugins/ok"}]}
        """)
        XCTAssertEqual(parsed.entries.map(\.name), ["ok"])
        XCTAssertEqual(parsed.skipped.count, 1)
    }

    func testMissingPluginsArrayThrows() {
        XCTAssertThrowsError(try parse("{\"name\":\"m\"}"))
        XCTAssertThrowsError(try parse("[]"))
    }

    func testResolveKeepsPathsInsideTheClone() throws {
        let root = URL(fileURLWithPath: "/tmp/clone")
        let inside = try PluginMarketplace.resolve("plugins/a", inside: root)
        XCTAssertEqual(inside.path, "/tmp/clone/plugins/a")
        XCTAssertThrowsError(try PluginMarketplace.resolve("../escape", inside: root))
        XCTAssertThrowsError(try PluginMarketplace.resolve("plugins/../../escape", inside: root))
    }
}
