import Testing
import Foundation
@testable import LlmIdeMac

@Suite("Project model")
struct ProjectTests {

    @Test func roundTripsCodable() throws {
        let p = Project(
            id: "01HBYZ123",
            displayName: "LLM IDE Mac",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            settings: ProjectSettings(
                language: "en",
                activeCLI: "claudeCode",
                linkedRepo: ProjectSettings.LinkedRepo(
                    kind: .github,
                    url: "https://github.com/owner/name",
                    remoteId: "owner/name",
                    defaultBranch: "main"
                ),
                notesFolderRelative: "Meetings",
                enabledPlugins: ["sample-summarizer"],
                uaBinaryOverride: "",
                regressionLookbackCount: 5,
                agentPersona: nil,
                docTemplatesActive: []
            ),
            schemaVersion: 1
        )
        let data = try AppJSON.iso8601Encoder.encode(p)
        let decoded = try AppJSON.iso8601Decoder.decode(Project.self, from: data)
        #expect(decoded == p)
    }

    @Test func toleratesUnknownFutureFields() throws {
        let json = """
        {
            "schemaVersion": 1,
            "id": "01HBYZ",
            "displayName": "X",
            "createdAt": "2026-05-26T00:00:00Z",
            "settings": {
                "language": "en",
                "activeCLI": "claudeCode",
                "notesFolderRelative": null,
                "enabledPlugins": [],
                "uaBinaryOverride": "",
                "regressionLookbackCount": 5,
                "agentPersona": null,
                "docTemplatesActive": [],
                "futureField": "ignored"
            }
        }
        """.data(using: .utf8)!
        let decoded = try AppJSON.iso8601Decoder.decode(Project.self, from: json)
        #expect(decoded.id == "01HBYZ")
        #expect(decoded.settings.language == "en")
    }

    @Test func refusesNewerSchemaVersion() throws {
        let json = """
        {"schemaVersion": 999, "id": "x", "displayName": "y", "createdAt": "2026-05-26T00:00:00Z",
         "settings": {"language": "en", "activeCLI": "claudeCode", "enabledPlugins": [],
                      "uaBinaryOverride": "", "regressionLookbackCount": 5,
                      "docTemplatesActive": []}}
        """.data(using: .utf8)!
        #expect(throws: Project.LoadError.unsupportedSchema(version: 999)) {
            _ = try Project.fromJSON(json)
        }
    }

    @Test func acceptsV1JSONWithAllOptionalFieldsAbsent() throws {
        // Keys for linkedRepo, notesFolderRelative, agentPersona omitted
        // entirely (not even `null`). Non-optional fields still present.
        let json = """
        {
            "schemaVersion": 1,
            "id": "no-opts",
            "displayName": "Y",
            "createdAt": "2026-05-26T00:00:00Z",
            "settings": {
                "language": "en",
                "activeCLI": "claudeCode",
                "enabledPlugins": [],
                "uaBinaryOverride": "",
                "regressionLookbackCount": 5,
                "docTemplatesActive": []
            }
        }
        """.data(using: .utf8)!
        let decoded = try Project.fromJSON(json)
        #expect(decoded.settings.linkedRepo == nil)
        #expect(decoded.settings.notesFolderRelative == nil)
        #expect(decoded.settings.agentPersona == nil)
    }

    @Test func unknownLinkedRepoKindFailsAsInvalidJSON() throws {
        let json = """
        {
            "schemaVersion": 1,
            "id": "bad-kind",
            "displayName": "Y",
            "createdAt": "2026-05-26T00:00:00Z",
            "settings": {
                "language": "en",
                "activeCLI": "claudeCode",
                "linkedRepo": {"kind": "bitbucket", "url": "x", "remoteId": "y"},
                "enabledPlugins": [],
                "uaBinaryOverride": "",
                "regressionLookbackCount": 5,
                "docTemplatesActive": []
            }
        }
        """.data(using: .utf8)!
        #expect(throws: Project.LoadError.invalidJSON(underlying: NSError(domain: "", code: 0))) {
            _ = try Project.fromJSON(json)
        }
    }

    @Test func malformedJSONFailsAsInvalidJSON() throws {
        let json = "{ not valid".data(using: .utf8)!
        #expect(throws: Project.LoadError.invalidJSON(underlying: NSError(domain: "", code: 0))) {
            _ = try Project.fromJSON(json)
        }
    }

    @Test func refusesSchemaVersionZero() throws {
        let json = """
        {"schemaVersion": 0, "id": "x", "displayName": "y", "createdAt": "2026-05-26T00:00:00Z",
         "settings": {"language": "en", "activeCLI": "claudeCode", "enabledPlugins": [],
                      "uaBinaryOverride": "", "regressionLookbackCount": 5,
                      "docTemplatesActive": []}}
        """.data(using: .utf8)!
        #expect(throws: Project.LoadError.unsupportedSchema(version: 0)) {
            _ = try Project.fromJSON(json)
        }
    }
}
