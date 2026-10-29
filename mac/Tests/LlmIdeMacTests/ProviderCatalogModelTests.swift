// The Provider catalog card: decoding the server's answers, the rules for the tools badge and
// the fallback order, and the model's state changes against a scripted API.
import XCTest
@testable import LlmIdeMacLib

final class ProviderCatalogDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testCatalogDecodesConnectionsAndSettings() throws {
        let r = try decode(LlmIdeAPIClient.CatalogResponse.self, """
        {"providers":[{"id":"groq","name":"Groq","baseURL":"https://api.groq.com/openai/v1","keyRequired":true,
          "local":false,"customBaseURL":false,"allowPrivate":false,"docsUrl":"https://console.groq.com/docs","notes":"",
          "connections":[{"id":"cat-groq","provider":"custom:cat-groq","catalogId":"groq","name":"Groq",
            "baseURL":"https://api.groq.com/openai/v1","allowPrivate":false,"enabled":true,"hasKey":true}]}],
         "settings":{"toolsEnabled":false,"fallbackEnabled":true,
           "fallbackOrder":[{"provider":"custom:cat-groq","model":"llama-3.3-70b-versatile"},{"provider":"custom:cat-xai"}],
           "toolOverrides":{"cat-groq/x":true},"egressAutoApprove":false}}
        """)
        XCTAssertEqual(r.providers[0].connections[0].provider, "custom:cat-groq")
        XCTAssertTrue(r.providers[0].connections[0].hasKey)
        XCTAssertFalse(r.settings.toolsEnabled)
        XCTAssertEqual(r.settings.fallbackOrder.map(\.model), ["llama-3.3-70b-versatile", nil])
        XCTAssertEqual(r.settings.toolOverrides["cat-groq/x"], true)
        XCTAssertFalse(r.settings.egressAutoApprove)
    }

    func testModelListDecodesCapabilityFlags() throws {
        let list = try decode(LlmIdeAPIClient.CatalogModelList.self, """
        {"models":[{"id":"a","toolsSupported":true,"toolsSource":"catalog","streaming":true,"contextWindow":131072},
                   {"id":"b","toolsSupported":false,"toolsSource":"unknown","streaming":true,"contextWindow":null}],
         "source":"live"}
        """)
        XCTAssertEqual(list.models.map(\.toolsSupported), [true, false])
        XCTAssertNil(list.models[1].contextWindow)
        XCTAssertNil(list.detail)
    }

    func testSettingsEncodeWithoutNilModel() throws {
        let s = LlmIdeAPIClient.CatalogSettings(fallbackOrder: [.init(provider: "custom:cat-groq")])
        let json = try String(data: JSONEncoder().encode(s), encoding: .utf8) ?? ""
        XCTAssertFalse(json.contains("\"model\""), "an absent model must not be sent as null")
        XCTAssertTrue(json.contains("\"toolsEnabled\":false"))
    }
}

final class ProviderCatalogRulesTests: XCTestCase {
    private func model(_ tools: Bool, _ source: String, ctx: Int? = nil) -> LlmIdeAPIClient.CatalogModel {
        .init(id: "m", toolsSupported: tools, toolsSource: source, streaming: true, contextWindow: ctx)
    }

    func testToolsBadgeSaysWhereTheFlagCameFrom() {
        XCTAssertEqual(ProviderCatalogRules.toolsBadge(model(true, "catalog")), "tools")
        XCTAssertEqual(ProviderCatalogRules.toolsBadge(model(true, "provider")), "tools")
        XCTAssertEqual(ProviderCatalogRules.toolsBadge(model(true, "inferred")), "tools (guessed)")
        XCTAssertEqual(ProviderCatalogRules.toolsBadge(model(true, "override")), "tools (yours)")
        XCTAssertNil(ProviderCatalogRules.toolsBadge(model(false, "unknown")))
        XCTAssertNotNil(ProviderCatalogRules.noToolsHint(model(false, "unknown")))
        XCTAssertNil(ProviderCatalogRules.noToolsHint(model(true, "catalog")))
    }

    func testContextText() {
        XCTAssertEqual(ProviderCatalogRules.contextText(model(true, "c", ctx: 131_072)), "131k ctx")
        XCTAssertEqual(ProviderCatalogRules.contextText(model(true, "c", ctx: 1_048_576)), "1.0M ctx")
        XCTAssertNil(ProviderCatalogRules.contextText(model(true, "c", ctx: nil)))
    }

    func testMoveStaysInBoundsAndPruneDropsStrangers() {
        typealias E = LlmIdeAPIClient.CatalogFallbackEntry
        let a = E(provider: "custom:cat-a"), b = E(provider: "custom:cat-b"), c = E(provider: "custom:cat-c")
        XCTAssertEqual(ProviderCatalogRules.moved([a, b, c], c, by: -1), [a, c, b])
        XCTAssertEqual(ProviderCatalogRules.moved([a, b, c], a, by: -1), [a, b, c])
        XCTAssertEqual(ProviderCatalogRules.moved([a, b, c], c, by: 1), [a, b, c])
        XCTAssertEqual(ProviderCatalogRules.pruned([a, b, a, c], connected: ["custom:cat-a", "custom:cat-c"]), [a, c])
    }

    func testFailureUsesTheServerMessage() {
        let e = APIError.http(status: 400, code: "VALIDATION_FAILED", message: "Groq needs an API key", details: nil)
        XCTAssertEqual(ProviderCatalogRules.failure(e), "Groq needs an API key")
    }
}

@MainActor
final class ProviderCatalogModelTests: XCTestCase {
    typealias C = LlmIdeAPIClient

    final class FakeAPI: ProviderCatalogAPI {
        var connections: [C.CatalogConnection] = []
        var settings = C.CatalogSettings()
        var connectError: Error?
        var testResult = C.CatalogTestResult(ok: true, detail: "connected, 2 chat models available", modelCount: 2)
        private(set) var connectedKeys: [String?] = []
        private(set) var savedSettings: [C.CatalogSettings] = []

        private func entry() -> C.CatalogProvider {
            C.CatalogProvider(id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1", keyRequired: true,
                              local: false, customBaseURL: false, allowPrivate: false, docsUrl: "", notes: "",
                              connections: connections)
        }
        func fetchProviderCatalog() async throws -> C.CatalogResponse { C.CatalogResponse(providers: [entry()], settings: settings) }
        func connectCatalogProvider(catalogId: String, apiKey: String?, baseURL: String?, slug: String?, name: String?,
                                    allowPrivate: Bool?) async throws -> C.CatalogConnection {
            connectedKeys.append(apiKey)
            if let connectError { throw connectError }
            let c = C.CatalogConnection(id: "cat-\(catalogId)", provider: "custom:cat-\(catalogId)", catalogId: catalogId,
                                        name: "Groq", baseURL: "https://api.groq.com/openai/v1", allowPrivate: false,
                                        enabled: true, hasKey: true)
            connections = [c]
            return c
        }
        func disconnectCatalogProvider(id: String) async throws -> Bool { connections = []; settings.fallbackOrder = []; return true }
        func testCatalogProvider(id: String) async throws -> C.CatalogTestResult { testResult }
        func fetchCatalogModels(id: String, refresh: Bool) async throws -> C.CatalogModelList {
            C.CatalogModelList(models: [], source: "static", detail: nil)
        }
        func saveProviderCatalogSettings(_ s: C.CatalogSettings) async throws -> C.CatalogSettings { savedSettings.append(s); settings = s; return s }
    }

    func testConnectTrimsTheKeyAndReloads() async {
        let api = FakeAPI()
        let model = ProviderCatalogModel(api: api)
        let ok = await model.connect(catalogId: "groq", apiKey: "  sk-abc  ")
        XCTAssertTrue(ok)
        XCTAssertEqual(api.connectedKeys, ["sk-abc"])
        XCTAssertEqual(model.connections.map(\.provider), ["custom:cat-groq"])
    }

    func testBlankKeyIsSentAsNilSoTheStoredKeyStays() async {
        let api = FakeAPI()
        let model = ProviderCatalogModel(api: api)
        _ = await model.connect(catalogId: "groq", apiKey: "   ")
        XCTAssertEqual(api.connectedKeys.count, 1)
        XCTAssertNil(api.connectedKeys[0])
    }

    func testConnectFailureShowsTheServerMessageAndKeepsNoKey() async {
        let api = FakeAPI()
        api.connectError = APIError.http(status: 400, code: "VALIDATION_FAILED", message: "Groq needs an API key", details: nil)
        let model = ProviderCatalogModel(api: api)
        let ok = await model.connect(catalogId: "groq", apiKey: "x")
        XCTAssertFalse(ok)
        XCTAssertEqual(model.actionError, "Groq needs an API key")
        XCTAssertTrue(model.connections.isEmpty)
    }

    func testSwitchesDefaultOffAndAreSavedAsTheServerAnswers() async {
        let api = FakeAPI()
        let model = ProviderCatalogModel(api: api)
        await model.load()
        XCTAssertFalse(model.settings.toolsEnabled)
        XCTAssertFalse(model.settings.fallbackEnabled)
        XCTAssertFalse(model.settings.egressAutoApprove, "fetch-url and web-search ask first unless the user opts out")
        await model.update { $0.toolsEnabled = true }
        XCTAssertTrue(model.settings.toolsEnabled)
        XCTAssertEqual(api.savedSettings.count, 1)
    }

    func testFallbackOrderOnlyKeepsConnectedProvidersAndMoves() async {
        let api = FakeAPI()
        let model = ProviderCatalogModel(api: api)
        _ = await model.connect(catalogId: "groq", apiKey: "sk-abc")
        let groq = model.connections[0]
        await model.setInFallback(groq, true)
        XCTAssertEqual(model.settings.fallbackOrder.map(\.provider), ["custom:cat-groq"])
        // a stranger in the list is dropped before saving
        await model.update { $0.fallbackOrder.append(.init(provider: "custom:cat-ghost")) }
        XCTAssertEqual(model.settings.fallbackOrder.map(\.provider), ["custom:cat-groq"])
        await model.setInFallback(groq, false)
        XCTAssertTrue(model.settings.fallbackOrder.isEmpty)
    }

    func testDisconnectClearsResultsAndReloads() async {
        let api = FakeAPI()
        let model = ProviderCatalogModel(api: api)
        _ = await model.connect(catalogId: "groq", apiKey: "sk-abc")
        let groq = model.connections[0]
        await model.test(groq)
        XCTAssertEqual(model.testResults[groq.id]?.ok, true)
        await model.disconnect(groq)
        XCTAssertNil(model.testResults[groq.id])
        XCTAssertTrue(model.connections.isEmpty)
    }
}
