import SwiftUI

/// Collapsible settings card for the System Feature Minimizer — matches
/// `SettingsSectionCard` styling used by Menu Bar, Auto Tasks, etc.
struct FeatureProfileSettingsSection: View {
    @ObservedObject var registry = FeatureRegistry.shared
    @Environment(AppEnvironment.self) private var environment
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        SettingsSectionCard(icon: "slider.horizontal.3", title: "Feature Minimizer") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint(
                    "Choose a preset or toggle individual components. Disabled features hide from the toolbar and stop background services."
                )

                HStack(spacing: Spacing.md) {
                    Text("Profile")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                    Picker("", selection: Binding(
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
                    .labelsHidden()
                    .pickerStyle(.menu)
                    Spacer()
                }

                Text(description(for: registry.currentPreset))
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Spacing.xs)

                let features = AppFeature.allCases
                let last = features.last
                ForEach(features) { feature in
                    featureRow(feature)
                    if feature != last { Divider().opacity(0.4) }
                }
            }
        }
    }

    @ViewBuilder
    private func featureRow(_ feature: AppFeature) -> some View {
        let t = theme.current
        let binding = Binding<Bool>(
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
        )
        HStack(spacing: Spacing.md) {
            Image(systemName: feature.systemImage)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(t.accent2)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(feature.displayName)
                    .font(Typography.body)
                    .foregroundStyle(t.text)
                if !feature.requiredDependencies.isEmpty {
                    Text("Requires \(feature.requiredDependencies.map(\.displayName).joined(separator: ", "))")
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                }
            }
            Spacer()
            Toggle("", isOn: binding)
                .toggleStyle(.switch)
                .controlSize(.small)
                .labelsHidden()
                .help(binding.wrappedValue ? "Disable \(feature.displayName)" : "Enable \(feature.displayName)")
        }
        .padding(.vertical, 2)
    }

    private func description(for preset: ProfilePreset) -> String {
        switch preset {
        case .fullPower:
            return "All features including 3D Code Graph, Mobile Sync, Gantt, and Auto Tasks."
        case .focusedAI:
            return "AI Chat, File Explorer, and DocGen only — lighter UI and fewer background services."
        case .minimalEditor:
            return "Distraction-free editor with Terminal and File Explorer."
        case .custom:
            return "Custom selection — toggling any component switches here automatically."
        }
    }
}
