import XCTest
@testable import LlmIdeMacLib

@MainActor
private final class SpyModule: AppModule {
    let feature: AppFeature
    var ready = true
    var startCount = 0
    var stopCount = 0
    var runtimeReady: Bool { ready }
    init(_ feature: AppFeature) { self.feature = feature }
    func start() { startCount += 1 }
    func stop() { stopCount += 1 }
}

@MainActor
final class FeatureRegistryTests: XCTestCase {

    private func makeRegistry() -> FeatureRegistry {
        let name = "FeatureRegistryTests-\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        suite.removePersistentDomain(forName: name)
        return FeatureRegistry(defaults: suite)
    }

    func testRefreshStartsOnlyEnabledModules() {
        let registry = makeRegistry()
        let graph = SpyModule(.codeGraph3D)
        let gantt = SpyModule(.ganttIssues)
        registry.register(module: graph)
        registry.register(module: gantt)
        registry.updateFeatureSet([.fileExplorer, .codeGraph3D], markCustom: false)
        XCTAssertEqual(graph.startCount, 1)
        XCTAssertEqual(gantt.startCount, 0)
    }

    func testDisablingFeatureStopsItsModule() {
        let registry = makeRegistry()
        let graph = SpyModule(.codeGraph3D)
        registry.register(module: graph)
        registry.updateFeatureSet([.fileExplorer, .codeGraph3D], markCustom: false)
        registry.updateFeatureSet([.fileExplorer], markCustom: false)
        XCTAssertEqual(graph.stopCount, 1)
    }

    func testRefreshIsIdempotent() {
        let registry = makeRegistry()
        let graph = SpyModule(.codeGraph3D)
        registry.register(module: graph)
        registry.updateFeatureSet([.fileExplorer, .codeGraph3D], markCustom: false)
        registry.refresh()
        registry.refresh()
        XCTAssertEqual(graph.startCount, 1)
        XCTAssertEqual(graph.stopCount, 0)
    }

    func testRuntimeReadyGatesStartAndTriggersStop() {
        let registry = makeRegistry()
        let chat = SpyModule(.agentChat)
        chat.ready = false
        registry.register(module: chat)
        registry.updateFeatureSet(Set(AppFeature.allCases), markCustom: false)
        XCTAssertEqual(chat.startCount, 0)      // not ready → never started
        chat.ready = true
        registry.refresh()
        XCTAssertEqual(chat.startCount, 1)      // became ready → started
        chat.ready = false
        registry.refresh()
        XCTAssertEqual(chat.stopCount, 1)       // lost readiness → stopped
    }

    func testPresetChangeStopsExcludedFeature() {
        let registry = makeRegistry()
        let mobile = SpyModule(.mobileSync)
        registry.register(module: mobile)
        registry.applyPreset(.fullPower)
        XCTAssertEqual(mobile.startCount, 1)
        registry.applyPreset(.focusedAI)        // preset excludes mobileSync
        XCTAssertEqual(mobile.stopCount, 1)
    }

    func testPersistenceRoundTripKeepsKeyFormat() {
        let suite = UserDefaults(suiteName: "FeatureRegistryTests-persist")!
        suite.removePersistentDomain(forName: "FeatureRegistryTests-persist")
        let registry = FeatureRegistry(defaults: suite)
        registry.updateFeatureSet([.fileExplorer, .terminal], markCustom: true)
        // Same key + JSON string-array format as the old @AppStorage code.
        let raw = suite.string(forKey: "active_features_json")!
        let decoded = try! JSONDecoder().decode([String].self, from: Data(raw.utf8))
        XCTAssertEqual(Set(decoded), ["file_explorer", "terminal"])
        let reloaded = FeatureRegistry(defaults: suite)
        XCTAssertEqual(reloaded.activeFeatures, [.fileExplorer, .terminal])
    }
}
