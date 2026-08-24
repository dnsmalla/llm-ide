import SwiftUI

/// Workspace presets, feature gates, and top-bar visibility in one card.
struct FeatureProfileSettingsSection: View {
    @ObservedObject var registry = FeatureRegistry.shared
    @Environment(AppEnvironment.self) private var environment
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    var body: some View {
        SettingsSectionCard(icon: "slider.horizontal.3", title: "Workspace") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint(
                    "Presets turn features off completely (toolbar + navigation). Toolbar toggles below only hide menu buttons — deep links and shortcuts still work."
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

                let features = AppFeature.settingsToggleable
                let lastFeature = features.last
                ForEach(features) { feature in
                    featureRow(feature)
                    if feature != lastFeature { Divider().opacity(0.4) }
                }

                Divider().padding(.vertical, Spacing.xs)

                Text("Menu bar")
                    .font(Typography.captionStrong)
                    .foregroundStyle(theme.current.textMuted)

                Picker("Home opens", selection: Binding(
                    get: { config.homeSection },
                    set: { config.homeSection = $0 }
                )) {
                    ForEach(ShellState.Section.allCases.filter { $0 != .settings && $0 != .live }, id: \.self) { section in
                        Text(section.label).tag(section.rawValue)
                    }
                }
                .pickerStyle(.menu)
                .padding(.bottom, Spacing.xs)

                let hideable = ShellState.Section.userHideable
                let lastSection = hideable.last
                ForEach(hideable, id: \.self) { section in
                    menuBarRow(for: section)
                    if section != lastSection { Divider().opacity(0.4) }
                }

                HStack {
                    Spacer()
                    Button("Show all toolbar items") { config.hiddenSidebarSections = [] }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(config.hiddenSidebarSections.isEmpty)
                }
                .padding(.top, Spacing.xs)
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

    @ViewBuilder
    private func menuBarRow(for section: ShellState.Section) -> some View {
        let t = theme.current
        let binding = Binding<Bool>(
            get: { !config.hiddenSidebarSections.contains(section.rawValue) },
            set: { isVisible in
                if isVisible {
                    config.hiddenSidebarSections.remove(section.rawValue)
                } else {
                    config.hiddenSidebarSections.insert(section.rawValue)
                }
            }
        )
        HStack(spacing: Spacing.md) {
            Image(systemName: section.systemImage)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(section.tint(t))
                .frame(width: 22, height: 22)
            Text(section.label)
                .font(Typography.body)
                .foregroundStyle(t.text)
            Spacer()
            Toggle("", isOn: binding)
                .toggleStyle(.switch)
                .controlSize(.small)
                .labelsHidden()
                .help(binding.wrappedValue ? "Hide \(section.label) in toolbar" : "Show \(section.label) in toolbar")
        }
        .padding(.vertical, 2)
    }

    private func description(for preset: ProfilePreset) -> String {
        switch preset {
        case .fullPower:
            return "All features including 3D Code Graph, Gantt, and Auto Tasks."
        case .focusedAI:
            return "AI Chat, File Explorer, and DocGen only — lighter UI and fewer background services."
        case .minimalEditor:
            return "Distraction-free editor with Terminal and File Explorer."
        case .custom:
            return "Custom selection — toggling any component switches here automatically."
        }
    }
}
