import XCTest
@testable import LlmIdeMacLib

/// Shell/Core mediums from the 2026-09-24 review.
@MainActor
final class ShellCoreMediumsTests: XCTestCase {

    /// A folder name with quotes or a backslash used to produce invalid JSON
    /// in `.claude/settings.json` — which is only written when absent, so it
    /// stayed broken.
    func testClaudeSettingsIsValidJSONForAnyName() throws {
        let name = #"Q3 "Alpha" \ plan"#
        let project = Project(id: "p", displayName: name, createdAt: Date(),
                              settings: ProjectSettings(language: "ja"))
        let json = ProjectScaffolder.makeClaudeSettings(project: project)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(obj["projectName"] as? String, name)
        XCTAssertEqual(obj["language"] as? String, "ja")
    }

    /// A recent on an unmounted external volume is kept, anything else missing is pruned.
    func testUnmountedVolumeDetection() {
        XCTAssertTrue(ProjectStore.isOnUnmountedVolume("/Volumes/NoSuchDisk-\(UUID().uuidString)/proj"))
        XCTAssertFalse(ProjectStore.isOnUnmountedVolume("/Users/nobody/gone-project"))
        XCTAssertFalse(ProjectStore.isOnUnmountedVolume("/Volumes"))
    }

    func testActivityFeedCapIsBounded() {
        XCTAssertEqual(ActivityStore.maxItems, 500)
    }
}
