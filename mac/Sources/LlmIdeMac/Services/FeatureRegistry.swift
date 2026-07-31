import SwiftUI
import Combine

public protocol AppModule {
    var feature: AppFeature { get }
    func start(environment: AppEnvironment)
    func stop(environment: AppEnvironment)
}

@MainActor
public final class FeatureRegistry: ObservableObject {
    public static let shared = FeatureRegistry()
    
    @AppStorage("active_features_json") private var activeFeaturesJSON: String = ""
    @Published public private(set) var activeFeatures: Set<AppFeature> = Set(AppFeature.allCases)
    @Published public private(set) var currentPreset: ProfilePreset = .fullPower
    
    private var modules: [AppFeature: AppModule] = [:]
    
    private init() {
        loadSavedFeatures()
    }
    
    public func register(module: AppModule) {
        modules[module.feature] = module
    }
    
    public func isEnabled(_ feature: AppFeature) -> Bool {
        return activeFeatures.contains(feature)
    }
    
    public func applyPreset(_ preset: ProfilePreset, environment: AppEnvironment) {
        self.currentPreset = preset
        if preset != .custom {
            updateFeatureSet(preset.features, environment: environment)
        }
    }
    
    public func updateFeatureSet(_ newFeatures: Set<AppFeature>, environment: AppEnvironment) {
        var validated = newFeatures
        for feature in newFeatures {
            validated.formUnion(feature.requiredDependencies)
        }
        
        guard validated != activeFeatures else { return }
        
        let disabled = activeFeatures.subtracting(validated)
        let enabled = validated.subtracting(activeFeatures)
        
        // 1. Gracefully stop background services for disabled features
        for feature in disabled {
            modules[feature]?.stop(environment: environment)
        }
        
        // 2. Commit active state
        self.activeFeatures = validated
        saveFeatures()
        
        // 3. Start background services for newly enabled features
        for feature in enabled {
            modules[feature]?.start(environment: environment)
        }
    }
    
    private func saveFeatures() {
        let array = Array(activeFeatures).map { $0.rawValue }
        if let data = try? JSONEncoder().encode(array), let json = String(data: data, encoding: .utf8) {
            activeFeaturesJSON = json
        }
    }
    
    private func loadSavedFeatures() {
        guard !activeFeaturesJSON.isEmpty,
              let data = activeFeaturesJSON.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String].self, from: data) else {
            activeFeatures = Set(AppFeature.allCases)
            return
        }
        activeFeatures = Set(decoded.compactMap { AppFeature(rawValue: $0) })
    }
}