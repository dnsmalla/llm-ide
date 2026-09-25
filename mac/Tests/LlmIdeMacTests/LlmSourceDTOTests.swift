// Decode-shape guard: catches server/client field-name drift before it ships
// (the isAuthRoute allowlist miss during the server plan was exactly this
// class of bug, one layer further down the stack).
import XCTest
@testable import LlmIdeMacLib

final class LlmSourceDTOTests: XCTestCase {
    func testDecodesListResponse() throws {
        let json = """
        {"sources":[{"id":"builtin","name":"Central Skills","origin":"builtin",
        "location":"/repo/.skills","builtin":true,"version":"3.0.0",
        "installed":true,"skillCount":57,"agentCount":2,"commandCount":3,"templateCount":4,
        "hookCount":1,"mcpCount":1,"enabled":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.LlmSourceInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.sources.count, 1)
        XCTAssertEqual(decoded.sources[0].id, "builtin")
        XCTAssertNil(decoded.sources[0].ref)
        XCTAssertEqual(decoded.sources[0].agentCount, 2)
        XCTAssertEqual(decoded.sources[0].commandCount, 3)
        XCTAssertEqual(decoded.sources[0].templateCount, 4)
        XCTAssertEqual(decoded.sources[0].hookCount, 1)
        XCTAssertEqual(decoded.sources[0].mcpCount, 1)
    }

    /// A v27 server (renamed endpoints, pre-MCP) omits agentCount/hookCount/
    /// mcpCount. The list must still decode — defaulting the missing counts to
    /// 0 — instead of throwing keyNotFound and rendering the section empty.
    func testDecodesListResponseMissingNewCountFields() throws {
        let json = """
        {"sources":[{"id":"builtin","name":"Central Skills","origin":"builtin",
        "location":"/repo/.skills","builtin":true,"version":"3.0.0",
        "installed":true,"skillCount":57,"enabled":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.LlmSourceInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.sources.count, 1)
        XCTAssertEqual(decoded.sources[0].skillCount, 57)
        XCTAssertEqual(decoded.sources[0].agentCount, 0)
        XCTAssertEqual(decoded.sources[0].commandCount, 0)
        XCTAssertEqual(decoded.sources[0].templateCount, 0)
        XCTAssertEqual(decoded.sources[0].hookCount, 0)
        XCTAssertEqual(decoded.sources[0].mcpCount, 0)
    }

    func testDecodesAddResponseWithoutListOnlyFields() throws {
        let json = """
        {"source":{"id":"other","name":"other","origin":"local",
        "location":"/tmp/other-repo","builtin":false,"version":"3.0.0"}}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let source: LlmIdeAPIClient.LlmSourceSummary }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.source.id, "other")
        XCTAssertEqual(decoded.source.origin, "local")
    }

    func testDecodesDiscoveryDetail() throws {
        let json = """
        {"agents":[{"name":"reviewer","description":"reviews code","path":"/repo/agents/reviewer.md"}],
        "hooks":[{"event":"PreToolUse","matcher":"Bash","command":"echo hi"}],
        "mcpServers":[{"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}]}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LlmIdeAPIClient.LlmSourceDiscoveryDetail.self, from: json)
        XCTAssertEqual(decoded.agents.count, 1)
        XCTAssertEqual(decoded.agents[0].name, "reviewer")
        XCTAssertEqual(decoded.hooks.count, 1)
        XCTAssertEqual(decoded.hooks[0].event, "PreToolUse")
        XCTAssertEqual(decoded.hooks[0].matcher, "Bash")
        XCTAssertEqual(decoded.mcpServers.count, 1)
        XCTAssertEqual(decoded.mcpServers[0].name, "filesystem")
        XCTAssertEqual(decoded.mcpServers[0].command, "npx")
        XCTAssertEqual(decoded.mcpServers[0].args, ["-y", "@modelcontextprotocol/server-filesystem"])
        // Pre-commands/templates response shape: the newer families decode as
        // nil (the view falls back to `?? []`), not as a keyNotFound throw.
        XCTAssertNil(decoded.commands)
        XCTAssertNil(decoded.templates)
    }

    func testDecodesDiscoveryDetailWithCommandsAndTemplates() throws {
        let json = """
        {"skills":[],"agents":[],
        "commands":[{"name":"ship-it","description":"release checklist","path":"/repo/commands/ship-it.md"}],
        "templates":[{"name":"incident-report","description":"post-incident writeup","path":"/repo/templates/incident-report.md"}],
        "hooks":[],"mcpServers":[]}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LlmIdeAPIClient.LlmSourceDiscoveryDetail.self, from: json)
        XCTAssertEqual(decoded.commands?.count, 1)
        XCTAssertEqual(decoded.commands?[0].name, "ship-it")
        XCTAssertEqual(decoded.commands?[0].id, "/repo/commands/ship-it.md")
        XCTAssertEqual(decoded.templates?.count, 1)
        XCTAssertEqual(decoded.templates?[0].name, "incident-report")
    }

    // MARK: - Per-item selection + update (server v56)

    func testDiscoveryItemsDecodeSelectionAndDefaultWhenAbsent() throws {
        let json = """
        {"skills":[{"name":"alpha","description":"a","path":"/k/skills/alpha/SKILL.md","enabled":false,"isNew":true},
                   {"name":"beta","description":"b","path":"/k/skills/beta/SKILL.md"}],
         "agents":[],"hooks":[],"mcpServers":[]}
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(LlmIdeAPIClient.LlmSourceDiscoveryDetail.self, from: json)
        XCTAssertEqual(d.skills?[0].enabled, false)
        XCTAssertEqual(d.skills?[0].isNew, true)
        // A pre-v56 server sends neither field: checked, not new.
        XCTAssertEqual(d.skills?[1].enabled, true)
        XCTAssertEqual(d.skills?[1].isNew, false)
    }

    func testListRowDisabledItemCountDefaultsToZero() throws {
        let json = """
        {"sources":[{"id":"builtin","name":"Central Skills","origin":"builtin","builtin":true,
        "installed":true,"skillCount":3,"enabled":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.LlmSourceInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.sources[0].disabledItemCount, 0)
    }

    func testDecodesUpdateStatuses() throws {
        let json = """
        {"sources":[{"id":"builtin","status":"update-available","localRev":"a","remoteRev":"b","checkedAt":"2026-09-25T00:00:00Z"},
                    {"id":"mine","status":"local"},
                    {"id":"team","status":"something-new"}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let sources: [LlmIdeAPIClient.LlmSourceUpdateStatus] }
        let s = try JSONDecoder().decode(Wrap.self, from: json).sources
        XCTAssertTrue(s[0].updateAvailable)
        XCTAssertFalse(s[1].updateAvailable)
        XCTAssertTrue(s[1].isLocal)
        XCTAssertFalse(s[2].updateAvailable, "an unknown status never shows the badge")
    }

    func testUpdateResultDecodesAndSummarises() throws {
        let json = """
        {"ok":true,"fromRev":"a","toRev":"b",
         "added":[{"kind":"skill","name":"app-forge"},{"kind":"command","name":"app-forge"}],
         "removed":[{"kind":"skill","name":"old"}],
         "corrected":[".skills-lock","agent-tool definitions"]}
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(LlmIdeAPIClient.LlmSourceUpdateResult.self, from: json)
        XCTAssertEqual(r.added.count, 2)
        let text = r.summary(sourceName: "Central Skills", projectSkills: "llm-ide")
        XCTAssertTrue(text.contains("Central Skills updated"), text)
        XCTAssertTrue(text.contains("2 added (app-forge skill, /app-forge command)"), text)
        XCTAssertTrue(text.contains("1 removed (old skill)"), text)
        XCTAssertTrue(text.contains(".skills-lock"), text)
        XCTAssertTrue(text.contains("project skills (llm-ide)"), text)
    }

    func testUpdateResultFromOldServerAndNoChanges() throws {
        // A pre-v56 server answers { ok, installed } only.
        let r = try JSONDecoder().decode(LlmIdeAPIClient.LlmSourceUpdateResult.self,
                                         from: #"{"ok":true,"installed":true}"#.data(using: .utf8)!)
        XCTAssertTrue(r.added.isEmpty && r.removed.isEmpty && r.corrected.isEmpty)
        XCTAssertEqual(r.summary(sourceName: "team", projectSkills: nil), "team is up to date — nothing changed.")
    }
}
