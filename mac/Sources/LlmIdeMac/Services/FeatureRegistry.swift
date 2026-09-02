import SwiftUI
import Combine

/// Anything a feature module can switch on and off. The concrete services
/// (GraphAutoUpdater, LiveSessionMirror, …) already have these methods;
/// conformance is declared where each module is defined.
@MainActor
protocol FeatureService: AnyObject {
    func start()
    func stop()
}

/// One per toggleable feature. Owns the mapping feature → services and is
/// the only place that starts/stops them. Rule: init is free, `start()`
/// does the work, `stop()` undoes it; both idempotent.
@MainActor
protocol AppModule: AnyObject {
    var feature: AppFeature { get }
    /// Runtime preconditions beyond the feature flag (auth, sub-settings).
    /// `refresh()` re-reads this, so call sites signal changes (login,
    /// logout) by calling `FeatureRegistry.refresh()`.
    var runtimeReady: Bool { get }
    func start()
    func stop()
}

extension AppModule {
    var runtimeReady: Bool { true }
}

@MainActor
final class FeatureRegistry: ObservableObject {
    static let shared = FeatureRegistry()

    /// Same key + format the old @AppStorage code used, so existing users'
    /// saved feature sets survive this rewrite.
    static let defaultsKey = "active_features_json"

    @Published private(set) var activeFeatures: Set<AppFeature> = Set(AppFeature.allCases)
    @Published private(set) var currentPreset: ProfilePreset = .fullPower

    private let defaults: UserDefaults
    private var modules: [AppFeature: AppModule] = [:]
    /// Features whose module is currently started. Registry-level guard so
    /// a module's start/stop is called once per transition even if the
    /// underlying service forgot its own guard.
    private var running: Set<AppFeature> = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        loadSavedFeatures()
    }

    func register(module: AppModule) {
        modules[module.feature] = module
    }

    /// Features present in this binary. LlmIdeMacApp sets this from
    /// FeatureCatalog at boot; a compiled-out feature can never be enabled,
    /// started, or shown as available. Kept as a settable property (not a
    /// FeatureCatalog reference) so this core type stays catalog-agnostic.
    var compiledFeatures: Set<AppFeature> = Set(AppFeature.allCases) {
        didSet { refresh() }
    }

    func isEnabled(_ feature: AppFeature) -> Bool {
        activeFeatures.contains(feature) && compiledFeatures.contains(feature)
    }

    /// Reconcile running modules with `activeFeatures` × `runtimeReady`.
    /// Idempotent; call after login/logout and any feature-set change.
    func refresh() {
        for feature in AppFeature.allCases {
            guard let module = modules[feature] else { continue }
            let shouldRun = isEnabled(feature) && module.runtimeReady
            if shouldRun && !running.contains(feature) {
                module.start()
                running.insert(feature)
            } else if !shouldRun && running.contains(feature) {
                module.stop()
                running.remove(feature)
            }
        }
    }

    /// Apply a preset's feature set, intersected with `compiledFeatures`. A
    /// preset built for the full app (e.g. Minimal Code Editor = fileExplorer
    /// + terminal) can name only features a lite build excluded entirely; if
    /// the intersection is empty, applying it would zero out the active set
    /// with no module able to start, so this leaves `activeFeatures` (and
    /// `currentPreset`) untouched instead. Can't happen for the Full Power
    /// preset, whose feature set is `AppFeature.allCases` — its intersection
    /// with any non-empty `compiledFeatures` is always non-empty.
    func applyPreset(_ preset: ProfilePreset) {
        guard preset != .custom else {
            currentPreset = preset
            return
        }
        let applicable = preset.features.intersection(compiledFeatures)
        guard !applicable.isEmpty else { return }
        currentPreset = preset
        updateFeatureSet(applicable, markCustom: false)
    }

    func updateFeatureSet(_ newFeatures: Set<AppFeature>, markCustom: Bool = true) {
        var validated = newFeatures
        for feature in newFeatures {
            validated.formUnion(feature.requiredDependencies)
        }
        validated = AppFeature.validated(validated)

        if markCustom, currentPreset != .custom {
            currentPreset = .custom
        }
        // Unchanged set still refreshes: a preset re-apply must reconcile
        // modules registered after the set was first persisted.
        guard validated != activeFeatures else { refresh(); return }
        activeFeatures = validated
        saveFeatures()
        refresh()
    }

    private func saveFeatures() {
        let array = activeFeatures.map { $0.rawValue }
        if let data = try? JSONEncoder().encode(array),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: Self.defaultsKey)
        }
    }

    private func loadSavedFeatures() {
        guard let json = defaults.string(forKey: Self.defaultsKey),
              let data = json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String].self, from: data) else {
            activeFeatures = Set(AppFeature.allCases)
            return
        }
        activeFeatures = Set(decoded.compactMap { AppFeature(rawValue: $0) })
    }
}
