import Testing
import Foundation
@testable import LlmIdeMacLib

/// Plugin git installs clone onto this Mac, so the URL gate must refuse
/// cleartext http and any host that names this machine or a private network.
@Suite("Plugin git URL gate")
struct PluginGitURLGateTests {
    @Test("https and git@ shorthand for public hosts are accepted")
    func acceptsPublic() throws {
        #expect(try PluginGitInstaller.normalize(" https://github.com/owner/repo.git ")
            == "https://github.com/owner/repo.git")
        #expect(try PluginGitInstaller.normalize("git@gitlab.com:owner/repo.git") == "git@gitlab.com:owner/repo.git")
        #expect(try PluginGitInstaller.normalize("https://8.8.8.8/owner/repo") == "https://8.8.8.8/owner/repo")
    }

    @Test("plain http and other schemes are refused")
    func refusesCleartext() {
        for raw in ["http://github.com/owner/repo", "ssh://git@github.com/owner/repo", "file:///tmp/repo"] {
            #expect(throws: PluginGitInstaller.InstallError.self) { try PluginGitInstaller.normalize(raw) }
        }
    }

    @Test("loopback, private, link-local and unspecified hosts are refused",
          arguments: [
            "https://localhost/x", "https://LOCALHOST./x", "https://foo.localhost/x", "https://nas.local/x",
            "https://127.0.0.1/x", "https://127.8.9.10/x", "https://0.0.0.0/x",
            "https://10.1.2.3/x", "https://172.16.0.1/x", "https://172.31.255.255/x", "https://192.168.1.1/x",
            "https://169.254.169.254/x", "https://100.64.0.1/x", "https://255.255.255.255/x",
            "https://[::1]/x", "https://[::]/x", "https://[fe80::1]/x", "https://[fd00::1]/x",
            "https://[::ffff:127.0.0.1]/x", "https://[0:0:0:0:0:0:0:1]/x",
            // Numeric shorthands git/curl resolve to 127.0.0.1.
            "https://2130706433/x", "https://0x7f.1/x", "https://127.1/x", "https://0177.0.0.1/x",
            "git@127.0.0.1:owner/repo.git", "git@localhost:owner/repo.git", "git@[::1]:owner/repo.git",
          ])
    func refusesLocal(raw: String) {
        #expect(throws: PluginGitInstaller.InstallError.self) { try PluginGitInstaller.normalize(raw) }
    }

    @Test("ranges stop at their edges")
    func rangeEdges() {
        #expect(!PluginGitInstaller.isDisallowedHost("172.32.0.1"))
        #expect(!PluginGitInstaller.isDisallowedHost("172.15.0.1"))
        #expect(!PluginGitInstaller.isDisallowedHost("100.128.0.1"))
        #expect(!PluginGitInstaller.isDisallowedHost("2606:4700::1111"))
        #expect(!PluginGitInstaller.isDisallowedHost("[2606:4700::1111]"))
        #expect(!PluginGitInstaller.isDisallowedHost("github.com"))
    }
}

/// Consenting from the sidebar row must show everything that would run.
@Suite("MCP consent prompt")
struct McpConsentPromptTests {
    @Test("a stdio server lists the full command, every arg and env names but no values")
    func stdioMessage() {
        let prompt = McpConsentPrompt(
            pluginId: "p1", name: "files", isHosted: false, command: "npx",
            args: ["-y", "@scope/server@1.2.3", "--root", "/Users/me/My Docs"],
            url: nil, envNames: ["TOKEN", "API_BASE"], headerNames: [])
        #expect(prompt.dialogTitle.contains("files"))
        #expect(prompt.message.contains("npx"))
        for arg in ["-y", "@scope/server@1.2.3", "--root", "“/Users/me/My Docs”"] {
            #expect(prompt.message.contains(arg))
        }
        #expect(prompt.message.contains("API_BASE, TOKEN"))
    }

    @Test("env values never reach the message")
    func noEnvValues() throws {
        let json = """
        {"id":"p2","name":"gh","transport":"stdio","command":"gh-mcp","args":[],
         "env":{"GH_TOKEN":"supersecret"},"credentialMissing":false,"source":"manual",
         "builtin":false,"enabled":false,"consented":false}
        """
        let plugin = try JSONDecoder().decode(LlmIdeAPIClient.McpPluginInfo.self, from: Data(json.utf8))
        let prompt = McpConsentPrompt(plugin: plugin)
        #expect(prompt.message.contains("GH_TOKEN"))
        #expect(!prompt.message.contains("supersecret"))
        #expect(prompt.message.contains("Arguments: none"))
    }

    @Test("a hosted server shows its URL and header names")
    func hostedMessage() {
        let prompt = McpConsentPrompt(
            pluginId: "p3", name: "remote", isHosted: true, command: nil, args: [],
            url: "https://mcp.example.com/sse", envNames: [], headerNames: ["Authorization"])
        #expect(prompt.message.contains("https://mcp.example.com/sse"))
        #expect(prompt.message.contains("Headers: Authorization"))
        #expect(prompt.message.contains("Environment variables: none"))
    }
}

@Suite("Library list load generations")
struct LibraryLoadGenerationsTests {
    @Test("an older load is stale once a newer one starts; lists are independent")
    func staleness() {
        var gens = LibraryLoadGenerations()
        let first = gens.begin(.mcpPlugins)
        #expect(gens.isCurrent(first, for: .mcpPlugins))
        let second = gens.begin(.mcpPlugins)
        #expect(!gens.isCurrent(first, for: .mcpPlugins))
        #expect(gens.isCurrent(second, for: .mcpPlugins))
        let other = gens.begin(.connectors)
        #expect(gens.isCurrent(other, for: .connectors))
        #expect(gens.isCurrent(second, for: .mcpPlugins))
    }
}

@Suite("Source ingest in-flight guard")
@MainActor
struct SourceIngestInFlightTests {
    @Test("a second begin for the same source is refused until the first ends")
    func guardsPerSource() {
        let id = "test-\(UUID().uuidString)"
        let other = "test-\(UUID().uuidString)"
        #expect(SourceIngestInFlight.begin(id))
        #expect(!SourceIngestInFlight.begin(id))
        #expect(SourceIngestInFlight.begin(other))
        SourceIngestInFlight.end(id)
        SourceIngestInFlight.end(other)
        #expect(!SourceIngestInFlight.isRunning(id))
        #expect(SourceIngestInFlight.begin(id))
        SourceIngestInFlight.end(id)
    }
}

@Suite("Slack ingest — seen-ledger failures")
@MainActor
struct SlackMarkSeenFailureTests {
    private struct MarkError: LocalizedError {
        var errorDescription: String? { "ledger down" }
    }

    @Test("a failed markSeen is reported, not swallowed as success")
    func reportsMarkSeenFailure() async {
        let message = LlmIdeAPIClient.SlackMessage(ts: "1.0", channelId: "C1", user: "u", text: "hi", threadTs: nil)
        let result = await SlackSource.ingest(
            channels: ["C1"],
            lookbackDays: 1,
            fetch: { _, _ in
                LlmIdeAPIClient.SlackFetchResult(messages: [message], skipped: .init(overCap: 0))
            },
            writeNote: { _, _ in },
            markSeen: { _, _, _ in throw MarkError() })
        guard case .failure(let msg, let imported) = result else {
            Issue.record("expected .failure, got \(result)")
            return
        }
        #expect(imported == 1)
        #expect(msg.contains("C1"))
        #expect(msg.contains("ledger down"))
    }
}
