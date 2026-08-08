// mac/Tests/LlmIdeMacTests/SourceConnectorRawDirTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class SourceConnectorRawDirTests: XCTestCase {
    private func makeSlackManifest() -> SourceConnectorManifest {
        SourceConnectorManifest(
            id: "slack", displayName: "Slack", icon: "message", emptyText: "No messages",
            platforms: ["slack"], mode: .fetch,
            inboxFolder: "SlackArchive",     // legacy; must NOT be used as raw location
            noteType: "slack",
            endpoints: .init(test: "/t", fetch: "/f", seen: "/s", classify: "/c"),
            adapter: "SlackAdapter", configFields: [], rawHeaders: [:], noiseFilter: nil)
    }

    func testEnsureSetupCreatesNoteTypeFolderNotInboxFolder() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let connector = SourceConnector(manifest: makeSlackManifest(), adapterFactory: {
            fatalError("adapter not constructed in this test")
        })
        try connector.ensureSetup(at: root)

        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("slack").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("SlackArchive").path))
    }
}
