// Decode-shape guard: catches server/client field-name drift before it ships.
import XCTest
@testable import LlmIdeMacLib

final class McpPluginDTOTests: XCTestCase {
    func testDecodesListResponse() throws {
        let json = """
        {"plugins":[{"id":"slack","name":"Slack","command":"npx","args":["-y","@slack/mcp"],
        "env":{"TOKEN":"t"},"source":"claude","builtin":false,"enabled":true,"consented":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugins: [LlmIdeAPIClient.McpPluginInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.plugins.count, 1)
        XCTAssertEqual(decoded.plugins[0].id, "slack")
        XCTAssertEqual(decoded.plugins[0].command, "npx")
        XCTAssertEqual(decoded.plugins[0].args, ["-y", "@slack/mcp"])
        XCTAssertEqual(decoded.plugins[0].env?["TOKEN"], "t")
        XCTAssertEqual(decoded.plugins[0].source, "claude")
        XCTAssertEqual(decoded.plugins[0].enabled, true)
        XCTAssertEqual(decoded.plugins[0].consented, true)
    }

    func testDecodesListResponseDefaultsMissingFlagsToFalse() throws {
        let json = """
        {"plugins":[{"id":"linear","name":"Linear","command":"npx","args":[],"source":"manual","builtin":false}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugins: [LlmIdeAPIClient.McpPluginInfo] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.plugins[0].enabled, false)
        XCTAssertEqual(decoded.plugins[0].consented, false)
        XCTAssertNil(decoded.plugins[0].env)
    }

    func testDecodesAddResponseWithoutPerUserFields() throws {
        let json = """
        {"plugin":{"id":"slack","name":"Slack","command":"npx","args":["-y","@slack/mcp"],"source":"manual","builtin":false}}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugin: LlmIdeAPIClient.McpPluginSummary }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.plugin.id, "slack")
        XCTAssertEqual(decoded.plugin.source, "manual")
    }

    func testDecodesClaudeSourcesScan() throws {
        let json = """
        {"servers":[{"name":"linear","command":"npx","args":["-y","@linear/mcp"],"env":{"TOKEN":"x"}}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let servers: [LlmIdeAPIClient.ClaudeMcpSource] }
        let decoded = try JSONDecoder().decode(Wrap.self, from: json)
        XCTAssertEqual(decoded.servers.count, 1)
        XCTAssertEqual(decoded.servers[0].name, "linear")
        XCTAssertEqual(decoded.servers[0].env?["TOKEN"], "x")
    }
    // MARK: - Hosted transport

    // A hosted server carries no `command`. While that field was required,
    // decoding the WHOLE list threw as soon as one hosted server existed —
    // and hosted is what GitHub, Sentry and Notion all are now.
    func testDecodesHostedPluginWithNoCommand() throws {
        let json = """
        {"plugins":[{"id":"sentry","name":"Sentry","transport":"http","url":"https://mcp.sentry.dev/mcp",
        "headers":{"Authorization":"••••"},"source":"catalog","builtin":false,"enabled":true,"consented":true}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugins: [LlmIdeAPIClient.McpPluginInfo] }
        let p = try JSONDecoder().decode(Wrap.self, from: json).plugins[0]
        XCTAssertNil(p.command)
        XCTAssertEqual(p.transport, "http")
        XCTAssertEqual(p.url, "https://mcp.sentry.dev/mcp")
        XCTAssertTrue(p.isHosted)
        XCTAssertEqual(p.endpointSummary, "https://mcp.sentry.dev/mcp")
        // Header values arrive redacted; the name is what the UI shows.
        XCTAssertEqual(p.headers?["Authorization"], "••••")
    }

    func testTransportDefaultsToStdioForPreTransportRecords() throws {
        let json = """
        {"plugins":[{"id":"old","name":"Old","command":"uvx","args":["x"],"source":"claude","builtin":false}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugins: [LlmIdeAPIClient.McpPluginInfo] }
        let p = try JSONDecoder().decode(Wrap.self, from: json).plugins[0]
        XCTAssertEqual(p.transport, "stdio")
        XCTAssertFalse(p.isHosted)
        XCTAssertEqual(p.endpointSummary, "uvx x")
    }

    func testDecodesCredentialDescriptorAndMissingFlag() throws {
        let json = """
        {"plugins":[{"id":"github","name":"GitHub","transport":"http","url":"https://api.githubcopilot.com/mcp/",
        "credential":{"vaultKey":"mcp.github.token","target":"header","name":"Authorization","label":"GitHub token"},
        "credentialMissing":true,"source":"catalog","builtin":false}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let plugins: [LlmIdeAPIClient.McpPluginInfo] }
        let p = try JSONDecoder().decode(Wrap.self, from: json).plugins[0]
        XCTAssertEqual(p.credential?.vaultKey, "mcp.github.token")
        XCTAssertEqual(p.credential?.target, "header")
        XCTAssertTrue(p.credentialMissing, "the UI needs this to say the server will fail to authenticate")
        // The descriptor must never carry a value.
        XCTAssertNil(p.headers)
    }

    // MARK: - Catalog

    func testDecodesCatalogResponse() throws {
        let json = """
        {"servers":[
          {"id":"filesystem","name":"Filesystem","description":"files","transport":"stdio","command":"npx",
           "args":["-y","@modelcontextprotocol/server-filesystem"],
           "requiresArg":{"label":"Directory to expose","placeholder":"/Users/you"},"registered":false},
          {"id":"sentry","name":"Sentry","description":"errors","transport":"http",
           "url":"https://mcp.sentry.dev/mcp","oauth":true,"registered":true}
        ]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let servers: [LlmIdeAPIClient.McpCatalogEntry] }
        let servers = try JSONDecoder().decode(Wrap.self, from: json).servers
        XCTAssertEqual(servers.count, 2)

        let fs = servers[0]
        XCTAssertEqual(fs.requiresArg?.label, "Directory to expose")
        XCTAssertFalse(fs.isHosted)
        XCTAssertFalse(fs.oauth)
        XCTAssertFalse(fs.registered)

        let sentry = servers[1]
        XCTAssertTrue(sentry.isHosted)
        XCTAssertTrue(sentry.oauth, "an OAuth server must not be prompted for a token")
        XCTAssertNil(sentry.requiresArg)
        XCTAssertTrue(sentry.registered, "already registered — the menu offers it as added, not addable")
    }

    // MARK: - Scan sources

    // The scanners now emit hosted entries too, so these must decode without
    // a command as well.
    func testDecodesHostedScanSources() throws {
        let json = """
        {"servers":[{"name":"ctx","transport":"http","url":"https://mcp.context7.com/mcp"},
                    {"name":"local","transport":"stdio","command":"uvx","args":["x"]}]}
        """.data(using: .utf8)!
        struct Wrap: Decodable { let servers: [LlmIdeAPIClient.ClaudeMcpSource] }
        let servers = try JSONDecoder().decode(Wrap.self, from: json).servers
        XCTAssertTrue(servers[0].isHosted)
        XCTAssertNil(servers[0].command)
        XCTAssertEqual(servers[0].url, "https://mcp.context7.com/mcp")
        XCTAssertFalse(servers[1].isHosted)
        XCTAssertEqual(servers[1].command, "uvx")
    }

}
