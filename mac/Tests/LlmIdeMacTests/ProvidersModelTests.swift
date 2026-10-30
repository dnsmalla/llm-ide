// Settings → Providers: one list over three stores. The pure row rules (dedupe, type labels, what a
// "Move to catalog" sends), the model's edit routing against a recording fake (which store each change
// reaches), and the section registration (two sections, the old ones gone).
import XCTest
@testable import LlmIdeMacLib

typealias PC = LlmIdeAPIClient

func providersTestConnection(_ id: String, catalogId: String, name: String = "X", url: String = "https://api.example.com/v1",
                        enabled: Bool = true, hasKey: Bool = true, priv: Bool = false) -> PC.CatalogConnection {
    PC.CatalogConnection(id: id, provider: "custom:\(id)", catalogId: catalogId, name: name, baseURL: url,
                        allowPrivate: priv, enabled: enabled, hasKey: hasKey)
}

func providersTestEntry(_ id: String, name: String? = nil, generic: Bool = false, local: Bool = false,
                   connections: [PC.CatalogConnection] = []) -> PC.CatalogProvider {
    PC.CatalogProvider(id: id, name: name ?? id, baseURL: generic ? "" : "https://api.\(id).com/v1", keyRequired: !local,
                      local: local, customBaseURL: generic, allowPrivate: generic || local, docsUrl: "", notes: "",
                      connections: connections)
}

func providersTestCustom(_ name: String, url: String, claude: String? = nil, openAI: Bool = true,
                    enabled: Bool = true) -> CustomProvider {
    var p = CustomProvider(name: name, baseURL: url, apiKey: "", models: [AIModel(id: "m1", displayName: "m1")],
                           isOpenAICompatible: openAI, description: "", anthropicBaseURL: claude)
    p.apiKey = "custom.\(p.id.lowercased()).apiKey"
    p.isEnabled = enabled
    return p
}

func providersTestInput(catalog: [PC.CatalogProvider] = [], known: Bool = true, custom: [CustomProvider] = [],
                   keys: Set<String>? = [], shared: String = "") -> ProviderListInput {
    ProviderListInput(catalogProviders: catalog, catalogKnown: known, custom: custom,
                      builtIns: ProviderCatalog.all, configuredKeys: keys, sharedBaseURL: shared)
}

final class ProviderRowRulesTests: XCTestCase {
    func testTypeLabelsAreTheTwoUserFacingNames() {
        XCTAssertEqual(ProviderKind.openAIAdapter.label, "OpenAI-compatible (adapter)")
        XCTAssertEqual(ProviderKind.claudeEngine.label, "Claude-compatible (Claude engine)")
    }

    func testCustomKindFollowsTheAnthropicDoor() {
        XCTAssertEqual(ProviderRowBuilder.kind(of: providersTestCustom("a", url: "https://a/v1")), .openAIAdapter)
        XCTAssertEqual(ProviderRowBuilder.kind(of: providersTestCustom("a", url: "https://a/v1", claude: "https://a/anthropic")), .claudeEngine)
        XCTAssertEqual(ProviderRowBuilder.kind(of: providersTestCustom("a", url: "https://a/anthropic", openAI: false)), .claudeEngine)
        XCTAssertEqual(ProviderRowBuilder.kind(of: providersTestCustom("a", url: "https://a/v1", claude: "  ")), .openAIAdapter,
                       "a blank Anthropic URL is absent, as on the server")
    }

    func testNormalizedURLIgnoresCaseSlashAndQuery() {
        XCTAssertEqual(ProviderRowBuilder.normalizedURL(" HTTPS://API.Example.com/v1/// "), "https://api.example.com/v1")
        XCTAssertEqual(ProviderRowBuilder.normalizedURL("https://api.example.com/v1?x=1"), "https://api.example.com/v1")
        XCTAssertEqual(ProviderRowBuilder.normalizedURL("not a url"), "")
    }

    func testEveryConnectionIsShownOnce() {
        let groq = providersTestConnection("cat-groq", catalogId: "groq", name: "Groq", url: "https://api.groq.com/openai/v1")
        let rows = ProviderRowBuilder.rows(providersTestInput(catalog: [providersTestEntry("groq", connections: [groq])]))
        XCTAssertEqual(rows.filter { $0.isCatalog }.map(\.name), ["Groq"])
        XCTAssertEqual(rows.filter(\.isCatalog).first?.kind, .openAIAdapter)
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "row ids are unique")
    }

    func testLegacyCustomProviderOnACatalogUrlIsHiddenNotDeleted() {
        let c = providersTestConnection("cat-openai-compatible-home", catalogId: "openai-compatible", url: "https://openrouter.ai/api/v1")
        let dup = providersTestCustom("OpenRouter", url: "https://OpenRouter.ai/api/v1/")
        let other = providersTestCustom("Local", url: "http://localhost:11434/v1")
        let rows = ProviderRowBuilder.rows(providersTestInput(catalog: [providersTestEntry("openai-compatible", generic: true, connections: [c])],
                                                 custom: [dup, other]))
        XCTAssertFalse(rows.contains { $0.source == .custom(dup.id) }, "same endpoint, same type: listed once")
        XCTAssertTrue(rows.contains { $0.source == .custom(other.id) })
    }

    func testClaudeCompatibleProviderStaysEvenOnACatalogUrl() {
        let c = providersTestConnection("cat-openai-compatible-glm", catalogId: "openai-compatible", url: "https://api.z.ai/api/paas/v4")
        let glm = providersTestCustom("GLM", url: "https://api.z.ai/api/paas/v4", claude: "https://api.z.ai/api/anthropic")
        let rows = ProviderRowBuilder.rows(providersTestInput(catalog: [providersTestEntry("openai-compatible", generic: true, connections: [c])],
                                                 custom: [glm]))
        let row = rows.first { $0.source == .custom(glm.id) }
        XCTAssertEqual(row?.kind, .claudeEngine, "the catalog adapter cannot run it on the Claude engine")
        XCTAssertNil(row?.moveSource, "its OpenAI door is already in the catalog")
    }

    func testBuiltInKeyAndCatalogConnectionShowOnceWithANote() {
        let c = providersTestConnection("cat-openai", catalogId: "openai", name: "OpenAI", url: "https://api.openai.com/v1")
        let rows = ProviderRowBuilder.rows(providersTestInput(catalog: [providersTestEntry("openai", connections: [c])], keys: ["openai.apiKey"]))
        XCTAssertNil(rows.first { $0.builtInId == "openai" }, "the legacy row is replaced by the connection")
        let row = rows.first { $0.isCatalog }
        XCTAssertEqual(row?.alsoLegacyKey, true, "the older key is kept and said so")
        XCTAssertEqual(rows.filter { $0.name == "OpenAI" }.count, 1)
    }

    func testBuiltInRowsAppearOnlyWhileTheyHaveAKeyOrACliMode() {
        let rows = ProviderRowBuilder.rows(providersTestInput(keys: []))
        XCTAssertNotNil(rows.first { $0.builtInId == "anthropic" }, "Anthropic always shows")
        XCTAssertNotNil(rows.first { $0.builtInId == "openai" }, "codex CLI mode keeps it visible")
        XCTAssertNil(rows.first { $0.builtInId == "deepseek" }, "no key and no CLI: nothing to show")
        XCTAssertNil(rows.first { $0.builtInId == "custom" }, "the shared endpoint needs a key or URL")
        let keyed = ProviderRowBuilder.rows(providersTestInput(keys: ["deepseek.apiKey"]))
        XCTAssertEqual(keyed.first { $0.builtInId == "deepseek" }?.keyStatus, .stored)
        XCTAssertEqual(keyed.first { $0.builtInId == "deepseek" }?.moveSource, "deepseek")
    }

    func testBackendDownKeepsMacRowsWithUnknownKeyStatusAndOffersNoMove() {
        let cp = providersTestCustom("GLM", url: "https://api.z.ai/v1")
        let rows = ProviderRowBuilder.rows(providersTestInput(known: false, custom: [cp], keys: nil))
        let row = rows.first { $0.source == .custom(cp.id) }
        XCTAssertEqual(row?.keyStatus, .unknown, "never a false 'missing'")
        XCTAssertNil(row?.moveSource, "no Move to catalog without the catalog to dedupe against")
        XCTAssertTrue(rows.allSatisfy { $0.keyStatus == .unknown }, "with no vault listing nothing reads present or missing")
    }

    func testSharedEndpointHiddenOnceTheCatalogConnectsTheSameAddress() {
        let c = providersTestConnection("cat-openai-compatible-legacy", catalogId: "openai-compatible", url: "https://openrouter.ai/api/v1")
        let rows = ProviderRowBuilder.rows(providersTestInput(catalog: [providersTestEntry("openai-compatible", generic: true, connections: [c])],
                                                 keys: ["custom.apiKey"], shared: "https://openrouter.ai/api/v1/"))
        XCTAssertNil(rows.first { $0.builtInId == "custom" })
        let alone = ProviderRowBuilder.rows(providersTestInput(keys: ["custom.apiKey"], shared: "https://openrouter.ai/api/v1"))
        XCTAssertEqual(alone.first { $0.builtInId == "custom" }?.moveSource, "custom")
    }

    func testMoveIsOfferedOnlyForOpenAICompatibleCustomWithoutACatalogTwin() {
        let oa = providersTestCustom("A", url: "https://a.example.com/v1")
        let claudeOnly = providersTestCustom("B", url: "https://b.example.com/anthropic", openAI: false)
        let rows = ProviderRowBuilder.rows(providersTestInput(custom: [oa, claudeOnly], keys: [oa.apiKey]))
        XCTAssertEqual(rows.first { $0.source == .custom(oa.id) }?.moveSource, "custom:\(oa.id)")
        XCTAssertNil(rows.first { $0.source == .custom(claudeOnly.id) }?.moveSource)
    }

    func testMoveRequestNeverCarriesAKeyAndCopiesFromTheLegacyId() throws {
        let cp = providersTestCustom("My GLM", url: "http://localhost:11434/v1")
        let rows = ProviderRowBuilder.rows(providersTestInput(custom: [cp], keys: [cp.apiKey]))
        let row = try XCTUnwrap(rows.first { $0.source == .custom(cp.id) })
        let r = try XCTUnwrap(ProviderRowBuilder.moveRequest(for: row, custom: [cp]))
        XCTAssertNil(r.apiKey)
        XCTAssertEqual(r.copyKeyFrom, "custom:\(cp.id)")
        XCTAssertEqual(r.catalogId, "openai-compatible")
        XCTAssertEqual(r.baseURL, "http://localhost:11434/v1")
        XCTAssertEqual(r.allowPrivate, true, "loopback needs the private-network opt-in")
        XCTAssertEqual(r.slug, ProviderRowBuilder.slug(forCustomId: cp.id))
        XCTAssertNotNil(r.slug?.range(of: "^[a-z0-9]{1,24}$", options: .regularExpression), "a slug the server accepts")
        let built = ProviderRowBuilder.rows(providersTestInput(keys: ["google.apiKey"])).first { $0.builtInId == "google" }
        let g = try XCTUnwrap(built.flatMap { ProviderRowBuilder.moveRequest(for: $0, custom: []) })
        XCTAssertEqual([g.catalogId, g.copyKeyFrom], ["google", "google"])
    }

    func testUpdatingAConnectionResendsWhatDefinesIt() {
        let c = providersTestConnection("cat-openai-compatible-home", catalogId: "openai-compatible", name: "Home",
                           url: "http://nas.local:8000/v1", enabled: true, priv: true)
        let r = ProviderRowBuilder.request(updating: c, in: providersTestEntry("openai-compatible", generic: true), enabled: false)
        XCTAssertEqual([r.catalogId, r.slug, r.baseURL, r.name], ["openai-compatible", "home", "http://nas.local:8000/v1", "Home"])
        XCTAssertEqual([r.enabled, r.allowPrivate], [false, true])
        XCTAssertNil(r.apiKey)
        let hosted = ProviderRowBuilder.request(updating: providersTestConnection("cat-groq", catalogId: "groq"), in: providersTestEntry("groq"), apiKey: "k")
        XCTAssertNil(hosted.baseURL, "a hosted entry keeps its own URL")
        XCTAssertEqual(hosted.apiKey, "k")
    }

    func testAVeryLongModelListIsCollapsed() {
        let models = (0..<400).map { PC.CatalogModel(id: "m\($0)", toolsSupported: false, toolsSource: "unknown", streaming: true, contextWindow: nil) }
        XCTAssertEqual(ProviderRowBuilder.visibleModels(models, showAll: false).count, ProviderRowBuilder.modelPreviewLimit)
        XCTAssertEqual(ProviderRowBuilder.visibleModels(models, showAll: true).count, 400)
        XCTAssertEqual(ProviderRowBuilder.visibleModels(Array(models.prefix(5)), showAll: false).count, 5)
    }

    func testAVeryLongListOfRowsKeepsUniqueIds() {
        let many = (0..<200).map { providersTestCustom("P\($0)", url: "https://p\($0).example.com/v1") }
        let rows = ProviderRowBuilder.rows(providersTestInput(custom: many))
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
        XCTAssertGreaterThanOrEqual(rows.count, 200)
    }
}

@MainActor
final class ProvidersModelTests: XCTestCase {
    final class FakeAPI: ProviderListAPI {
        var catalog: [PC.CatalogProvider] = [providersTestEntry("openai"), providersTestEntry("openai-compatible", generic: true)]
        var settings = PC.CatalogSettings()
        var keys: Set<String> = []
        var failCatalog = false
        var verifyOK = true
        var ignoreEnabled = false
        private(set) var connectRequests: [PC.CatalogConnectRequest] = []
        private(set) var secretWrites: [(key: String, value: String)] = []
        private(set) var disconnected: [String] = []
        private(set) var verified: [(provider: String, mode: String, key: String?)] = []
        private(set) var synced: [[CustomProvider]] = []

        func fetchProviderCatalog() async throws -> PC.CatalogResponse {
            if failCatalog { throw APIError.http(status: 503, code: "DOWN", message: "backend down", details: nil) }
            return PC.CatalogResponse(providers: catalog, settings: settings, migration: nil)
        }
        func connectCatalogProvider(catalogId: String, apiKey: String?, baseURL: String?, slug: String?, name: String?,
                                    allowPrivate: Bool?) async throws -> PC.CatalogConnection {
            try await connectCatalogProvider(.init(catalogId: catalogId, apiKey: apiKey, baseURL: baseURL, slug: slug,
                                                   name: name, allowPrivate: allowPrivate))
        }
        func connectCatalogProvider(_ r: PC.CatalogConnectRequest) async throws -> PC.CatalogConnection {
            connectRequests.append(r)
            let id = "cat-\(r.catalogId)" + (r.slug.map { "-\($0)" } ?? "")
            let c = providersTestConnection(id, catalogId: r.catalogId, name: r.name ?? r.catalogId, url: r.baseURL ?? "https://api.\(r.catalogId).com/v1",
                               enabled: ignoreEnabled ? true : (r.enabled ?? true), hasKey: r.apiKey != nil || r.copyKeyFrom != nil)
            catalog = catalog.map { e in
                e.id == r.catalogId
                    ? PC.CatalogProvider(id: e.id, name: e.name, baseURL: e.baseURL, keyRequired: e.keyRequired, local: e.local,
                                        customBaseURL: e.customBaseURL, allowPrivate: e.allowPrivate, docsUrl: "", notes: "",
                                        connections: e.connections.filter { $0.id != id } + [c])
                    : e
            }
            return c
        }
        func disconnectCatalogProvider(id: String) async throws -> Bool {
            disconnected.append(id)
            catalog = catalog.map { e in
                PC.CatalogProvider(id: e.id, name: e.name, baseURL: e.baseURL, keyRequired: e.keyRequired, local: e.local,
                                  customBaseURL: e.customBaseURL, allowPrivate: e.allowPrivate, docsUrl: "", notes: "",
                                  connections: e.connections.filter { $0.id != id })
            }
            return true
        }
        func testCatalogProvider(id: String) async throws -> PC.CatalogTestResult { PC.CatalogTestResult(ok: true, detail: "ok", modelCount: 1) }
        func fetchCatalogModels(id: String, refresh: Bool) async throws -> PC.CatalogModelList { PC.CatalogModelList(models: [], source: "static", detail: nil) }
        func fetchProviderCatalogSettings() async throws -> PC.CatalogSettings { settings }
        func saveProviderCatalogSettings(_ s: PC.CatalogSettings) async throws -> PC.CatalogSettings { settings = s; return s }
        func configuredSecretKeys() async throws -> Set<String> { keys }
        func setSecret(key: String, value: String) async throws {
            secretWrites.append((key, value))
            if value.isEmpty { keys.remove(key) } else { keys.insert(key) }
        }
        func verifyProvider(_ provider: String, mode: String, apiKey: String?, baseUrl: String?) async throws -> PC.ProviderVerifyResult {
            verified.append((provider, mode, apiKey))
            return PC.ProviderVerifyResult(ok: verifyOK, detail: verifyOK ? nil : "key rejected")
        }
        func syncCustomProviders(_ providers: [CustomProvider], timeout: TimeInterval?) async throws { synced.append(providers) }
    }

    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() {
        suite = "ProvidersModelTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }
    override func tearDown() { defaults.removePersistentDomain(forName: suite) }

    private func make(_ api: FakeAPI = FakeAPI(), probe: @escaping (URL, String?) async -> (ok: Bool, text: String) = { _, _ in (true, "Connected") }) -> (ProvidersModel, FakeAPI) {
        (ProvidersModel(api: api, catalog: ProviderCatalogModel(api: api), defaults: defaults, probe: probe), api)
    }

    private func seed(_ p: CustomProvider) { XCTAssertTrue(p.save(to: defaults)) }

    func testKeyEditsGoToTheStoreThatOwnsTheRow() async throws {
        let cp = providersTestCustom("GLM", url: "https://api.z.ai/v1"); seed(cp)
        let api = FakeAPI()
        api.catalog = [providersTestEntry("groq", connections: [providersTestConnection("cat-groq", catalogId: "groq", name: "Groq")])]
        api.keys = ["deepseek.apiKey"]
        let (model, _) = make(api)
        await model.load()
        let rows = model.rows
        let catalogRow = try XCTUnwrap(rows.first { $0.isCatalog })
        let customRow = try XCTUnwrap(rows.first { $0.isCustom })
        let builtRow = try XCTUnwrap(rows.first { $0.builtInId == "deepseek" })

        let okCatalog = await model.setKey(catalogRow, key: "  sk-cat  ")
        XCTAssertTrue(okCatalog)
        XCTAssertEqual(api.connectRequests.last?.apiKey, "sk-cat")
        XCTAssertEqual(api.connectRequests.last?.catalogId, "groq")
        XCTAssertTrue(api.secretWrites.isEmpty, "a catalog key goes through connect, never the generic vault write")

        let okCustom = await model.setKey(customRow, key: "sk-custom")
        XCTAssertTrue(okCustom)
        XCTAssertEqual(api.secretWrites.last?.key, cp.apiKey)
        XCTAssertEqual(api.connectRequests.count, 1)

        let okBuilt = await model.setKey(builtRow, key: "sk-ds")
        XCTAssertTrue(okBuilt)
        XCTAssertEqual(api.verified.last?.provider, "deepseek")
        XCTAssertEqual(api.secretWrites.last?.key, "deepseek.apiKey")
    }

    func testARejectedBuiltInKeyIsNeverSaved() async throws {
        let api = FakeAPI(); api.verifyOK = false; api.keys = ["deepseek.apiKey"]
        let (model, _) = make(api)
        await model.load()
        let row = try XCTUnwrap(model.rows.first { $0.builtInId == "deepseek" })
        let ok = await model.setKey(row, key: "bad")
        XCTAssertFalse(ok)
        XCTAssertTrue(api.secretWrites.isEmpty, "a failed verification must not replace a working key")
        XCTAssertEqual(model.messages[row.id]?.ok, false)
    }

    func testBlankKeyDoesNothing() async throws {
        let (model, api) = make()
        await model.load()
        let row = try XCTUnwrap(model.rows.first { $0.builtInId == "anthropic" })
        let ok = await model.setKey(row, key: "   ")
        XCTAssertFalse(ok)
        XCTAssertTrue(api.secretWrites.isEmpty && api.verified.isEmpty)
    }

    func testToggleRoutesToServerForCatalogAndToTheMacListForCustom() async throws {
        let cp = providersTestCustom("GLM", url: "https://api.z.ai/v1"); seed(cp)
        let api = FakeAPI()
        api.catalog = [providersTestEntry("openai-compatible", generic: true,
                             connections: [providersTestConnection("cat-openai-compatible-home", catalogId: "openai-compatible", name: "Home", url: "http://nas.local/v1", priv: true)])]
        let (model, _) = make(api)
        await model.load()
        let cat = try XCTUnwrap(model.rows.first { $0.isCatalog })
        await model.toggleEnabled(cat)
        XCTAssertEqual(api.connectRequests.last?.enabled, false)
        XCTAssertEqual(api.connectRequests.last?.slug, "home")
        XCTAssertEqual(model.rows.first { $0.isCatalog }?.enabled, false)
        XCTAssertTrue(api.secretWrites.isEmpty)

        let before = api.synced.count
        let cus = try XCTUnwrap(model.rows.first { $0.isCustom })
        await model.toggleEnabled(cus)
        XCTAssertEqual(CustomProvider.loadAll(from: defaults).first?.isEnabled, false)
        XCTAssertEqual(api.connectRequests.count, 1, "a custom toggle never touches the catalog")
        XCTAssertGreaterThan(api.synced.count, before, "the server registry follows")
    }

    func testAnOlderServerThatIgnoresEnabledIsReportedNotPretended() async throws {
        let api = FakeAPI(); api.ignoreEnabled = true
        api.catalog = [providersTestEntry("groq", connections: [providersTestConnection("cat-groq", catalogId: "groq")])]
        let (model, _) = make(api)
        await model.load()
        let row = try XCTUnwrap(model.rows.first { $0.isCatalog })
        await model.toggleEnabled(row)
        XCTAssertEqual(model.messages[row.id]?.ok, false)
    }

    func testRemoveCustomDeletesLocallyClearsItsVaultKeyAndKeepsOthers() async throws {
        let a = providersTestCustom("A", url: "https://a.example.com/v1"), b = providersTestCustom("B", url: "https://b.example.com/v1")
        seed(a); seed(b)
        let api = FakeAPI(); api.keys = [a.apiKey, b.apiKey]
        let (model, _) = make(api)
        await model.load()
        let rowA = try XCTUnwrap(model.rows.first { $0.source == .custom(a.id) })
        await model.remove(rowA)
        XCTAssertEqual(CustomProvider.loadAll(from: defaults).map(\.id), [b.id])
        XCTAssertEqual(api.secretWrites.map(\.key), [a.apiKey])
        XCTAssertEqual(api.secretWrites.first?.value, "")
        XCTAssertTrue(api.disconnected.isEmpty)
    }

    func testRemoveCatalogDisconnectsOnlyThatConnection() async throws {
        let api = FakeAPI()
        api.catalog = [providersTestEntry("groq", connections: [providersTestConnection("cat-groq", catalogId: "groq")])]
        let (model, _) = make(api)
        await model.load()
        await model.remove(try XCTUnwrap(model.rows.first { $0.isCatalog }))
        XCTAssertEqual(api.disconnected, ["cat-groq"])
        XCTAssertTrue(api.secretWrites.isEmpty, "the server removes the key with the connection")
    }

    func testMoveToCatalogCopiesAndKeepsTheLegacyEntryAndKey() async throws {
        let cp = providersTestCustom("My GLM", url: "https://api.z.ai/api/paas/v4"); seed(cp)
        let api = FakeAPI(); api.keys = [cp.apiKey]
        let (model, _) = make(api)
        await model.load()
        let row = try XCTUnwrap(model.rows.first { $0.source == .custom(cp.id) })
        XCTAssertNotNil(row.moveSource)
        let ok = await model.moveToCatalog(row)
        XCTAssertTrue(ok)
        let sent = try XCTUnwrap(api.connectRequests.last)
        XCTAssertEqual(sent.copyKeyFrom, "custom:\(cp.id)")
        XCTAssertNil(sent.apiKey, "the Mac never holds the key")
        XCTAssertTrue(api.secretWrites.isEmpty, "nothing in the vault was changed from here")
        XCTAssertEqual(CustomProvider.loadAll(from: defaults).map(\.id), [cp.id], "the old entry is kept")
        XCTAssertFalse(model.rows.contains { $0.source == .custom(cp.id) }, "and it now shows once, as the catalog connection")
        XCTAssertEqual(model.rows.filter { $0.isCatalog }.count, 1)
        XCTAssertGreaterThan(api.synced.count, 0, "the registry was current before the server copied the key")
    }

    func testMoveFailureChangesNothing() async throws {
        let cp = providersTestCustom("My GLM", url: "https://api.z.ai/api/paas/v4"); seed(cp)
        final class Failing: ProviderListAPI {
            let inner = FakeAPI()
            func fetchProviderCatalog() async throws -> PC.CatalogResponse { try await inner.fetchProviderCatalog() }
            func connectCatalogProvider(catalogId: String, apiKey: String?, baseURL: String?, slug: String?, name: String?, allowPrivate: Bool?) async throws -> PC.CatalogConnection { throw APIError.http(status: 400, code: "VALIDATION_FAILED", message: "No stored key found for that provider", details: nil) }
            func connectCatalogProvider(_ request: PC.CatalogConnectRequest) async throws -> PC.CatalogConnection { throw APIError.http(status: 400, code: "VALIDATION_FAILED", message: "No stored key found for that provider", details: nil) }
            func disconnectCatalogProvider(id: String) async throws -> Bool { true }
            func testCatalogProvider(id: String) async throws -> PC.CatalogTestResult { try await inner.testCatalogProvider(id: id) }
            func fetchCatalogModels(id: String, refresh: Bool) async throws -> PC.CatalogModelList { try await inner.fetchCatalogModels(id: id, refresh: refresh) }
            func fetchProviderCatalogSettings() async throws -> PC.CatalogSettings { PC.CatalogSettings() }
            func saveProviderCatalogSettings(_ s: PC.CatalogSettings) async throws -> PC.CatalogSettings { s }
            func configuredSecretKeys() async throws -> Set<String> { [] }
            func setSecret(key: String, value: String) async throws {}
            func verifyProvider(_ provider: String, mode: String, apiKey: String?, baseUrl: String?) async throws -> PC.ProviderVerifyResult { try await inner.verifyProvider(provider, mode: mode, apiKey: apiKey, baseUrl: baseUrl) }
            func syncCustomProviders(_ providers: [CustomProvider], timeout: TimeInterval?) async throws {}
        }
        let api = Failing()
        let model = ProvidersModel(api: api, catalog: ProviderCatalogModel(api: api), defaults: defaults)
        await model.load()
        let row = try XCTUnwrap(model.rows.first { $0.source == .custom(cp.id) })
        let ok = await model.moveToCatalog(row)
        XCTAssertFalse(ok)
        XCTAssertEqual(model.messages[row.id]?.text, "No stored key found for that provider")
        XCTAssertEqual(CustomProvider.loadAll(from: defaults).count, 1)
    }

    func testBackendDownStillListsMacEntriesAndOffersNoMove() async throws {
        let cp = providersTestCustom("GLM", url: "https://api.z.ai/v1"); seed(cp)
        let api = FakeAPI(); api.failCatalog = true
        let (model, _) = make(api)
        await model.load()
        XCTAssertNotNil(model.catalog.loadError)
        let row = try XCTUnwrap(model.rows.first { $0.source == .custom(cp.id) })
        XCTAssertNil(row.moveSource)
        let moved = await model.moveToCatalog(row)
        XCTAssertFalse(moved)
        XCTAssertTrue(api.connectRequests.isEmpty)
    }

    func testClearKeyOnABuiltInOnlyBlanksItsVaultSlot() async throws {
        let api = FakeAPI(); api.keys = ["deepseek.apiKey"]
        let (model, _) = make(api)
        await model.load()
        let row = try XCTUnwrap(model.rows.first { $0.builtInId == "deepseek" })
        XCTAssertTrue(row.canClearKey)
        XCTAssertFalse(row.canRemove)
        await model.clearKey(row)
        XCTAssertEqual(api.secretWrites.map(\.key), ["deepseek.apiKey"])
        XCTAssertEqual(api.secretWrites.first?.value, "")
    }

    func testCustomTestNeedsAKeyUnlessLoopbackAndNeverPostsOverPlainRemoteHTTP() async throws {
        let remote = providersTestCustom("R", url: "https://r.example.com/v1"), local = providersTestCustom("L", url: "http://localhost:11434/v1")
        let insecure = providersTestCustom("I", url: "http://r.example.com/v1")
        [remote, local, insecure].forEach(seed)
        var probed: [(URL, String?)] = []
        let (model, _) = make(probe: { u, k in probed.append((u, k)); return (true, "Connected") })
        await model.load()
        func row(_ p: CustomProvider) throws -> ProviderRow { try XCTUnwrap(model.rows.first { $0.source == .custom(p.id) }) }
        await model.test(try row(remote))
        XCTAssertTrue(probed.isEmpty, "the stored key can't be read back, so no unauthenticated probe")
        await model.test(try row(remote), typedKey: "sk-x")
        XCTAssertEqual(probed.last?.0.absoluteString, "https://r.example.com/v1/models")
        XCTAssertEqual(probed.last?.1, "sk-x")
        await model.test(try row(local))
        XCTAssertEqual(probed.count, 2, "a local server needs no key")
        await model.test(try row(insecure), typedKey: "sk-x")
        XCTAssertEqual(probed.count, 2, "a key is never sent over plain http to a remote host")
    }

    func testSaveCustomStoresKeyFirstAndRefusesWhileTheListIsUnreadable() async throws {
        let (model, api) = make()
        let cp = providersTestCustom("GLM", url: "https://api.z.ai/v1")
        let err = await model.saveCustom(cp, apiKey: " sk-1 ")
        XCTAssertNil(err)
        XCTAssertEqual(api.secretWrites.first?.value, "sk-1")
        XCTAssertEqual(CustomProvider.loadAll(from: defaults).count, 1)
        defaults.set(Data("not json".utf8), forKey: CustomProvider.defaultsKey)
        model.refreshCustom()
        XCTAssertTrue(model.isListUnreadable)
        let blocked = await model.saveCustom(providersTestCustom("X", url: "https://x.example.com/v1"), apiKey: "")
        XCTAssertNotNil(blocked, "a save on top of an unreadable list would lose the user's providers")
    }

    func testSettingsWriteStartsFromTheServersCopy() async {
        let api = FakeAPI()
        let (model, _) = make(api)
        await model.load()
        api.settings.toolsEnabled = true          // changed elsewhere (the composer's Allow tools)
        await model.catalog.update { $0.fallbackEnabled = true }
        XCTAssertTrue(api.settings.toolsEnabled, "a stale snapshot must not undo the other change")
        XCTAssertTrue(api.settings.fallbackEnabled)
    }
}

final class ProviderSettingsRegistrationTests: XCTestCase {
    func testTwoSectionsReplaceTheOldFour() {
        XCTAssertEqual(ProvidersText.title, "Providers")
        XCTAssertEqual(ModelRoutingText.title, "Model routing")
        let old = ["Model Providers", "Custom Providers", "Provider catalog", "Tiers & Roles"]
        for title in [ProvidersText.title, ModelRoutingText.title] { XCTAssertFalse(old.contains(title)) }
    }

    func testTheCatalogSlotIsGoneAndAnchorsAreDistinct() {
        XCTAssertFalse(SettingsSectionSlot.allCases.map(\.rawValue).contains("providerCatalog"),
                       "Providers and Model routing are Settings' own cards, not contributed ones")
        let anchors = [SettingsAnchor.connections, SettingsAnchor.providers, SettingsAnchor.modelRouting]
        XCTAssertEqual(Set(anchors).count, 3)
    }

    @MainActor func testRegistryNoLongerCarriesAProviderCatalogCard() {
        let registry = SettingsSectionRegistry()
        for slot in SettingsSectionSlot.allCases { XCTAssertTrue(registry.sections(for: slot).isEmpty) }
    }

    func testModelRoutingExplanationsAreOneLineEach() {
        for text in [ModelRoutingText.tools, ModelRoutingText.egress, ModelRoutingText.fallback, ModelRoutingText.router,
                     ModelRoutingText.cap] {
            XCTAssertFalse(text.contains("\n"))
            XCTAssertEqual(text.components(separatedBy: ". ").count, 1, "one sentence: \(text)")
        }
    }
}
