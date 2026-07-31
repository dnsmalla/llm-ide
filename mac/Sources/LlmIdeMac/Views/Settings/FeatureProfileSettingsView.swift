import SwiftUI

struct FeatureProfileSettingsView: View {
    @ObservedObject var registry = FeatureRegistry.shared
    @Environment(AppEnvironment.self) private var environment
    
    var body: some View {
        Form {
            Section(header: Text("System Profile Presets").font(.headline)) {
                Picker("System Profile", selection: Binding(
                    get: { registry.currentPreset },
                    set: { newPreset in
                        registry.applyPreset(newPreset, environment: environment)
                        environment.syncServiceLifecycles()
                    }
                )) {
                    ForEach(ProfilePreset.allCases) { preset in
                        Text(preset.rawValue).tag(preset)
                    }
                }
                .pickerStyle(PopUpButtonPickerStyle())
                
                Text(description(for: registry.currentPreset))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Section(
                header: Text("Active System Components").font(.headline),
                footer: Text("Disabling components safely terminates background threads, releases RAM, and cleans up the UI.")
            ) {
                ForEach(AppFeature.allCases) { feature in
                    Toggle(isOn: Binding(
                        get: { registry.isEnabled(feature) },
                        set: { isEnabled in
                            var updated = registry.activeFeatures
                            if isEnabled {
                                updated.insert(feature)
                            } else {
                                updated.remove(feature)
                            }
                            registry.updateFeatureSet(updated, environment: environment)
                            environment.syncServiceLifecycles()
                        }
                    )) {
                        VStack(alignment: .leading) {
                            Text(feature.displayName)
                                .font(.body)
                            if !feature.requiredDependencies.isEmpty {
                                Text("Requires: \(feature.requiredDependencies.map { $0.displayName }.joined(separator: ", "))")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .padding()
    }
    
    private func description(for preset: ProfilePreset) -> String {
        switch preset {
        case .fullPower:
            return "Enables all features including 3D Code Graph, Mobile Sync, Gantt Boards, and Auto Tasks."
        case .focusedAI:
            return "Strips away complex IDE UI and background services. Keeps only AI Chat, File Explorer, and DocGen."
        case .minimalEditor:
            return "Turns the app into a lightweight, distraction-free code editor with Terminal and File Explorer."
        case .custom:
            return "Custom user-selected configuration."
        }
    }
}