import XCTest
@testable import LlmIdeMacLib

/// `system/project.json` carried six fields that were written at creation and
/// never read back: activeCLI, regressionLookbackCount, enabledPlugins,
/// agentPersona, notesFolderRelative, docTemplatesActive. They read as
/// authoritative configuration but drifted the moment the real setting changed
/// — a project would pin `activeCLI: "claude_code"` while the live value had
/// moved to something else.
///
/// These pin the removal: old files must still open, and the dead keys must
/// not come back on write.
final class ProjectSettingsSchemaTests: XCTestCase {

    /// A file written by the previous build — every removed key present.
    private let legacyJSON = """
    {
      "schemaVersion": 1,
      "id": "abc123",
      "displayName": "LLM",
      "createdAt": "2026-08-01T07:36:58Z",
      "settings": {
        "language": "ja",
        "activeCLI": "claude_code",
        "regressionLookbackCount": 5,
        "enabledPlugins": ["a", "b"],
        "agentPersona": "reviewer",
        "notesFolderRelative": "meetings",
        "docTemplatesActive": ["meeting-summary", "sprint-review"],
        "linkedRepo": {
          "kind": "github",
          "url": "https://github.com/acme/widgets",
          "remoteId": "acme/widgets",
          "defaultBranch": "main"
        }
      }
    }
    """

    func testLegacyFileStillOpensAndKeepsWhatMatters() throws {
        let p = try Project.fromJSON(Data(legacyJSON.utf8))

        XCTAssertEqual(p.id, "abc123")
        XCTAssertEqual(p.settings.language, "ja")
        XCTAssertEqual(p.settings.linkedRepo?.remoteId, "acme/widgets")
        XCTAssertEqual(p.settings.linkedRepo?.kind, .github)
    }

    /// The removed keys must not be re-emitted, or the drift comes straight
    /// back through the next write.
    func testRemovedKeysAreNotWrittenBack() throws {
        let p = try Project.fromJSON(Data(legacyJSON.utf8))
        let round = try JSONSerialization.jsonObject(with: p.toJSON()) as? [String: Any]
        let settings = try XCTUnwrap(round?["settings"] as? [String: Any])

        for dead in ["activeCLI", "regressionLookbackCount", "enabledPlugins",
                     "agentPersona", "notesFolderRelative", "docTemplatesActive"] {
            XCTAssertNil(settings[dead], "\(dead) was removed and must not be written back")
        }
        XCTAssertEqual(settings["language"] as? String, "ja")
        XCTAssertNotNil(settings["linkedRepo"])
    }

    /// Decoding is tolerant, so a file missing `language` opens rather than
    /// throwing — the old decoder used a non-optional `decode` for it.
    func testFileWithoutLanguageStillOpens() throws {
        let json = """
        {"schemaVersion":1,"id":"x","displayName":"n",
         "createdAt":"2026-08-01T07:36:58Z","settings":{}}
        """
        let p = try Project.fromJSON(Data(json.utf8))
        XCTAssertEqual(p.settings.language, "")
        XCTAssertNil(p.settings.linkedRepo)
    }

    func testRoundTripPreservesLinkedRepo() throws {
        let settings = ProjectSettings(
            language: "en",
            linkedRepo: .init(kind: .gitlab, url: "https://gitlab.com/a/b",
                              remoteId: "42", defaultBranch: "trunk"))
        let p = Project(id: "i", displayName: "d", createdAt: Date(), settings: settings)

        let decoded = try Project.fromJSON(p.toJSON())
        XCTAssertEqual(decoded.settings, settings)
    }
}

/// New projects stamped `language: ""` into project.json because that was
/// hard-coded at the seed site, so every scaffolded README / project.md /
/// CLAUDE.md / .claude/settings.json shipped with a blank language.
final class DefaultProjectSettingsLanguageTests: XCTestCase {

    func testNewProjectsInheritTheCachedLanguagePref() {
        let suite = "DefaultProjectSettingsLanguageTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let config = AppConfig(userDefaults: defaults)
        config.preferredLanguage = "ja"

        XCTAssertEqual(config.defaultProjectSettings().language, "ja")
    }

    /// The mirror persists, so the very first project created in a new launch
    /// (before Preferences has had a chance to re-fetch from the server) still
    /// gets a real language rather than a blank one.
    func testCachedLanguageSurvivesReload() {
        let suite = "DefaultProjectSettingsLanguageTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        AppConfig(userDefaults: defaults).preferredLanguage = "ja"

        XCTAssertEqual(AppConfig(userDefaults: defaults).preferredLanguage, "ja")
    }
}
