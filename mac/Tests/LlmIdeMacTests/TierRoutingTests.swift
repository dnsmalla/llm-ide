import Testing
import Foundation
@testable import LlmIdeMacLib

/// The pure tier resolver: every unset or unusable case answers nil, which
/// callers read as "use today's default" — routing must never make a run fail.
@Suite("Tier routing resolver")
struct TierRoutingTests {
    private func custom(id: String, enabled: Bool = true, anthropicURL: String? = nil) -> CustomProvider {
        var provider = CustomProvider(name: "GLM", baseURL: "https://api.z.ai/api/paas/v4", apiKey: "glm.apiKey",
                                      anthropicBaseURL: anthropicURL)
        provider.id = id
        provider.isEnabled = enabled
        return provider
    }

    private func config(_ route: TierRoute?, feature: RoutedFeature = .loop,
                        tier: RoutingTier = .cheap) -> TierRoutingConfig {
        TierRoutingConfig(tiers: route.map { [tier.rawValue: $0] } ?? [:],
                          features: [feature.rawValue: tier.rawValue])
    }

    /// A v67 server that reports every tier usable and Agent-capable, so the
    /// local checks below are what decide.
    private static let ready = TierRoutingServerState(
        apiVersion: 67,
        status: Dictionary(uniqueKeysWithValues: RoutingTier.allCases.map {
            ($0.rawValue, TierServerStatus(usable: true, reason: nil, agentCapable: true, agentReason: nil))
        }))

    private static func resolveReady(feature: RoutedFeature, config: TierRoutingConfig,
                                     customProviders: [CustomProvider],
                                     requiresAgentEngine: Bool = false, localCLIOnly: Bool = false) -> TierRoute? {
        TierRouting.resolve(feature: feature, config: config, customProviders: customProviders, server: ready,
                            requiresAgentEngine: requiresAgentEngine, localCLIOnly: localCLIOnly)
    }

    // MARK: - Server gate (API version + per-tier status)

    @Test func serverOlderThanV67OrUnknownRoutesNothing() {
        let route = TierRoute(provider: "anthropic", model: "claude-haiku-4-5")
        for version in [nil, 65, 66] as [Int?] {
            var server = Self.ready
            server.apiVersion = version
            #expect(TierRouting.resolve(feature: .loop, config: config(route), customProviders: [],
                                        server: server) == nil)
            // Auto Tasks too: one gate for every role.
            #expect(TierRouting.resolve(feature: .autoTasks, config: config(route, feature: .autoTasks),
                                        customProviders: [], server: server, localCLIOnly: true) == nil)
        }
        #expect(TierRouting.resolve(feature: .loop, config: config(route), customProviders: [],
                                    server: Self.ready) == route)
    }

    @Test func statusNotFetchedRoutesNothing() {
        let route = TierRoute(provider: "anthropic", model: "claude-haiku-4-5")
        let server = TierRoutingServerState(apiVersion: 67, status: nil)
        #expect(TierRouting.resolve(feature: .loop, config: config(route), customProviders: [], server: server) == nil)
    }

    @Test func serverUnusableTierIsDefault() {
        let route = TierRoute(provider: "openai", model: "gpt-5.5")
        var server = Self.ready
        server.status?["cheap"] = TierServerStatus(usable: false, reason: "no_key", agentCapable: false, agentReason: nil)
        #expect(TierRouting.resolve(feature: .loop, config: config(route), customProviders: [], server: server) == nil)
        #expect(TierRouting.serverUnusableReason(.cheap, server: server)?.contains("no API key") == true)
    }

    @Test func serverNotAgentCapableOnlyBlocksAgentEngineUse() {
        let route = TierRoute(provider: "custom:p1", model: "glm-5.2")
        let capable = custom(id: "p1", anthropicURL: "https://api.z.ai/api/anthropic")
        var server = Self.ready
        server.status?["cheap"] = TierServerStatus(usable: true, reason: nil, agentCapable: false,
                                                   agentReason: "not_agent_capable")
        #expect(TierRouting.resolve(feature: .loop, config: config(route), customProviders: [capable],
                                    server: server) == route)
        #expect(TierRouting.resolve(feature: .loop, config: config(route), customProviders: [capable],
                                    server: server, requiresAgentEngine: true) == nil)
    }

    @Test func autoTasksIgnoreServerStatusButNeedTheCLIInstalled() {
        let gemini = TierRoute(provider: "google", model: "gemini-3.6-flash")
        let table = config(gemini, feature: .autoTasks)
        var server = Self.ready
        server.status = [:]   // the server can't judge a local CLI
        #expect(TierRouting.resolve(feature: .autoTasks, config: table, customProviders: [], server: server,
                                    localCLIOnly: true, cliInstalled: { _ in true }) == gemini)
        #expect(TierRouting.resolve(feature: .autoTasks, config: table, customProviders: [], server: server,
                                    localCLIOnly: true, cliInstalled: { _ in false }) == nil)
    }

    @Test func onlyRoutedProviderConfigRefusalsAreRetried() {
        let refused = APIError.http(status: 400, code: "PROVIDER_UNAVAILABLE", message: "m", details: nil)
        let notCapable = APIError.http(status: 400, code: "PROVIDER_NOT_AGENT_CAPABLE", message: "m", details: nil)
        let generic = APIError.http(status: 502, code: "INTERNAL_ERROR", message: "m", details: nil)
        let validation = APIError.http(status: 400, code: "VALIDATION_FAILED", message: "m", details: nil)
        #expect(APILoopAgentRunner.shouldRetryWithoutRoute(refused, routedProvider: "custom:p1"))
        #expect(APILoopAgentRunner.shouldRetryWithoutRoute(notCapable, routedProvider: "custom:p1"))
        #expect(!APILoopAgentRunner.shouldRetryWithoutRoute(refused, routedProvider: nil))
        #expect(!APILoopAgentRunner.shouldRetryWithoutRoute(generic, routedProvider: "custom:p1"))
        #expect(!APILoopAgentRunner.shouldRetryWithoutRoute(validation, routedProvider: "custom:p1"))
    }

    @Test func statusDecodesTheServerShape() throws {
        let json = Data(#"{"usable":true,"agentCapable":false,"agentReason":"not_agent_capable"}"#.utf8)
        let status = try JSONDecoder().decode(TierServerStatus.self, from: json)
        #expect(status == TierServerStatus(usable: true, reason: nil, agentCapable: false,
                                           agentReason: "not_agent_capable"))
    }

    // MARK: - Local checks

    @Test func featureUnsetIsDefault() {
        let table = TierRoutingConfig(tiers: ["cheap": TierRoute(provider: "anthropic", model: "claude-haiku-4-5")])
        #expect(Self.resolveReady(feature: .loop, config: table, customProviders: []) == nil)
    }

    @Test func tierUnsetIsDefault() {
        #expect(Self.resolveReady(feature: .loop, config: config(nil), customProviders: []) == nil)
    }

    @Test func builtInRouteResolves() {
        let route = TierRoute(provider: "openai", model: "gpt-5.4-mini")
        #expect(Self.resolveReady(feature: .loop, config: config(route), customProviders: []) == route)
    }

    @Test func emptyModelIsDefault() {
        let route = TierRoute(provider: "anthropic", model: " ")
        #expect(Self.resolveReady(feature: .loop, config: config(route), customProviders: []) == nil)
    }

    @Test func unknownProviderIsDefault() {
        let route = TierRoute(provider: "glm", model: "glm-5.2")
        #expect(Self.resolveReady(feature: .loop, config: config(route), customProviders: []) == nil)
    }

    @Test func deletedCustomProviderIsDefault() {
        let route = TierRoute(provider: "custom:gone", model: "glm-5.2")
        #expect(Self.resolveReady(feature: .loop, config: config(route),
                                    customProviders: [custom(id: "other")]) == nil)
    }

    @Test func disabledCustomProviderIsDefault() {
        let route = TierRoute(provider: "custom:p1", model: "glm-5.2")
        #expect(Self.resolveReady(feature: .loop, config: config(route),
                                    customProviders: [custom(id: "p1", enabled: false)]) == nil)
    }

    @Test func enabledCustomProviderResolves() {
        let route = TierRoute(provider: "custom:p1", model: "glm-5.2")
        #expect(Self.resolveReady(feature: .loop, config: config(route),
                                    customProviders: [custom(id: "p1")]) == route)
    }

    @Test func agentEngineNeedsAnthropicCompatibleCustomProvider() {
        let route = TierRoute(provider: "custom:p1", model: "glm-5.2")
        let table = config(route, feature: .quickChat)
        #expect(Self.resolveReady(feature: .quickChat, config: table, customProviders: [custom(id: "p1")],
                                    requiresAgentEngine: true) == nil)
        let capable = custom(id: "p1", anthropicURL: "https://api.z.ai/api/anthropic")
        #expect(Self.resolveReady(feature: .quickChat, config: table, customProviders: [capable],
                                    requiresAgentEngine: true) == route)
    }

    @Test func agentEngineRejectsNonAnthropicBuiltIn() {
        let table = config(TierRoute(provider: "openai", model: "gpt-5.5"), feature: .quickChat)
        #expect(Self.resolveReady(feature: .quickChat, config: table, customProviders: [],
                                    requiresAgentEngine: true) == nil)
        let claude = TierRoute(provider: "anthropic", model: "claude-haiku-4-5")
        #expect(Self.resolveReady(feature: .quickChat, config: config(claude, feature: .quickChat),
                                    customProviders: [], requiresAgentEngine: true) == claude)
    }

    @Test func localCLIOnlyRejectsProvidersWithoutACLI() {
        let deepseek = config(TierRoute(provider: "deepseek", model: "deepseek-chat"), feature: .autoTasks)
        #expect(Self.resolveReady(feature: .autoTasks, config: deepseek, customProviders: [],
                                    localCLIOnly: true) == nil)
        let customRoute = config(TierRoute(provider: "custom:p1", model: "glm-5.2"), feature: .autoTasks)
        #expect(Self.resolveReady(feature: .autoTasks, config: customRoute, customProviders: [custom(id: "p1")],
                                    localCLIOnly: true) == nil)
        let gemini = TierRoute(provider: "google", model: "gemini-3.6-flash")
        #expect(Self.resolveReady(feature: .autoTasks, config: config(gemini, feature: .autoTasks),
                                    customProviders: [], localCLIOnly: true) == gemini)
    }

    @Test func cliToolMapping() {
        #expect(TierRouting.cliTool(forProvider: "anthropic") == .claudeCode)
        #expect(TierRouting.cliTool(forProvider: "openai") == .openai)
        #expect(TierRouting.cliTool(forProvider: "google") == .gemini)
        #expect(TierRouting.cliTool(forProvider: "deepseek") == nil)
        #expect(TierRouting.cliTool(forProvider: "custom:p1") == nil)
    }

    @Test func configRoundTripsAsTheWireShape() throws {
        let table = TierRoutingConfig(tiers: ["cheap": TierRoute(provider: "custom:p1", model: "glm-5.2")],
                                      features: ["subagents": "cheap"])
        let data = try JSONEncoder().encode(table)
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect((json["tiers"] as? [String: Any])?["cheap"] != nil)
        #expect((json["features"] as? [String: String])?["subagents"] == "cheap")
        #expect(try JSONDecoder().decode(TierRoutingConfig.self, from: data) == table)
    }

    @Test func persistenceRoundTripsAndToleratesGarbage() throws {
        let suite = "TierRoutingTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(TierRoutingConfig.load(from: defaults) == TierRoutingConfig())
        let table = TierRoutingConfig(tiers: ["strong": TierRoute(provider: "anthropic", model: "claude-opus-5-5")],
                                      features: ["loop": "strong"])
        #expect(table.save(to: defaults))
        #expect(TierRoutingConfig.load(from: defaults) == table)
        defaults.set(Data("not json".utf8), forKey: TierRoutingConfig.defaultsKey)
        #expect(TierRoutingConfig.load(from: defaults) == TierRoutingConfig())
    }
}
