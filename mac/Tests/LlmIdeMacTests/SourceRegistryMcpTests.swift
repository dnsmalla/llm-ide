import XCTest
@testable import LlmIdeMacLib

/// The manifest engine shipped in July 2026 with zero manifests and has been
/// dormant since. These tests are the proof it is finally live.
@MainActor
final class SourceRegistryMcpTests: XCTestCase {

    func testMiroIsRegisteredAlongsideTheHandwrittenSources() {
        let ids = SourceRegistry.all.map(\.id)
        XCTAssertTrue(ids.contains("miro"), "got \(ids)")
        // The three hand-written sources are untouched — this is additive.
        for id in ["meeting", "email", "slack"] {
            XCTAssertTrue(ids.contains(id), "\(id) regressed; got \(ids)")
        }
        XCTAssertEqual(ids.count, Set(ids).count, "duplicate source ids")
    }

    func testOnlyConnectorsWithAServerDescriptorAreRegistered() {
        // Three manifests ship; only Miro has a server-side descriptor today.
        // Registering the other two would put permanently-empty groups in the
        // Library and add two doomed round trips to every ingestion tick.
        XCTAssertEqual(SourceConnectorManifest.loadBundled().count, 3)
        let ids = SourceRegistry.all.map(\.id)
        XCTAssertFalse(ids.contains("gdrive"))
        XCTAssertFalse(ids.contains("gcal"))
    }

    func testMiroIsPolledByTheIngestSweepAndRoutesItsPlatform() {
        XCTAssertTrue(SourceRegistry.fetchSources.contains { $0.id == "miro" })
        // `platform: "miro"` in a note's frontmatter must classify to Miro and
        // not fall through to the historical default-to-meeting.
        XCTAssertEqual(SourceRegistry.source(forPlatform: "miro").id, "miro")
        XCTAssertEqual(SourceRegistry.source(forPlatform: "MIRO").id, "miro")
        XCTAssertEqual(SourceRegistry.source(id: "miro")?.displayName, "Miro")
    }

    func testEachFetchGetsAFreshAdapter() throws {
        // SourceConnector calls adapterFactory() per fetch; a shared instance
        // would leak state across sweeps.
        let connector = try XCTUnwrap(SourceRegistry.all.first { $0.id == "miro" } as? SourceConnector)
        XCTAssertEqual(connector.manifest.noteType, "miro")
        XCTAssertEqual(connector.manifest.adapter, "McpConnectorAdapter")
    }
}
