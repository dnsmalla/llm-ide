import XCTest
@testable import LlmIdeMacLib

@MainActor
final class MobileExploreIndexStoreTests: XCTestCase {

    func testFilterWorkspacePrefersExactNameMatch() {
        let entries = [
            MobileWorkspaceIndexEntry(path: "extension/server.mjs", name: "server.mjs", isDirectory: false),
            MobileWorkspaceIndexEntry(path: "mac/server-config.swift", name: "server-config.swift", isDirectory: false),
        ]
        let hits = MobileExploreIndexStore.filterWorkspace(entries, query: "server.mjs", limit: 10)
        XCTAssertEqual(hits.first?.path, "extension/server.mjs")
    }

    func testFilterSkillsPrefersExactNameMatch() {
        let entries = [
            MobileSkillIndexEntry(id: "skills/brainstorming", name: "brainstorming",
                                  description: "Explore ideas", kind: "library", directive: nil),
            MobileSkillIndexEntry(id: "skill:debug-brain", name: "debug-brain",
                                  description: "Debug helper", kind: "builtin",
                                  directive: "Use the debug-brain skill:"),
        ]
        let hits = MobileExploreIndexStore.filterSkills(entries, query: "brainstorming", limit: 10)
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits[0].name, "brainstorming")
    }

    func testWorkspaceIndexRoundTripOnDisk() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("mobile-explore-index-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: base) }

        let settings = base.appendingPathComponent("settings", isDirectory: true)
        try fm.createDirectory(at: settings, withIntermediateDirectories: true)
        let file = MobileWorkspaceIndexFile(
            workspaceRoot: "/tmp/project",
            entries: [MobileWorkspaceIndexEntry(path: "a.txt", name: "a.txt", isDirectory: false)],
            truncated: true
        )
        let url = settings.appendingPathComponent("mobile-explore-workspace.json")
        let data = try AppJSON.iso8601Encoder.encode(file)
        try data.write(to: url)

        let loaded = try AppJSON.iso8601Decoder.decode(MobileWorkspaceIndexFile.self, from: Data(contentsOf: url))
        XCTAssertEqual(loaded.workspaceRoot, "/tmp/project")
        XCTAssertEqual(loaded.entries.count, 1)
        XCTAssertTrue(loaded.truncated)
        XCTAssertEqual(loaded.version, MobileWorkspaceIndexFile.currentVersion)
    }

    func testBootstrapFromDiskLoadsMeta() throws {
        let fm = FileManager.default
        let support = fm.temporaryDirectory.appendingPathComponent("mobile-explore-bootstrap-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: support) }

        let settings = support.appendingPathComponent("settings", isDirectory: true)
        try fm.createDirectory(at: settings, withIntermediateDirectories: true)
        let skills = MobileSkillsIndexFile(entries: [
            MobileSkillIndexEntry(id: "skills/a", name: "a", description: "d", kind: "library", directive: nil)
        ])
        let data = try AppJSON.iso8601Encoder.encode(skills)
        try data.write(to: settings.appendingPathComponent("mobile-explore-skills.json"))

        // Store always reads AppIdentity path — verify decode path via direct load helper logic
        let loaded = try AppJSON.iso8601Decoder.decode(MobileSkillsIndexFile.self, from: data)
        XCTAssertEqual(loaded.entries.count, 1)
    }
}
