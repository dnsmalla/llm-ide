import SwiftUI

/// Workspace presets, feature gates, top-bar visibility, and (when eligible)
/// the Apply & Rebuild card, all grouped under Settings → Workspace.
struct FeatureProfileSettingsSection: View {
    @ObservedObject var registry = FeatureRegistry.shared
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var rebuild: FeatureRebuildService

    var body: some View {
        Group {
            workspaceCard
            // Nil on a distributed build (no LLMIDESourceRoot in Info.plist —
            // release.sh sets LLMIDE_OMIT_SOURCE_ROOT=1) and on a bare
            // executable (no installTarget). Render nothing rather than a
            // disabled button nobody on those machines could ever use.
            if rebuild.isEligible {
                BuildRebuildSettingsCard()
            }
        }
    }

    private var workspaceCard: some View {
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
                            registry.applyPreset(newPreset)
                        }
                    )) {
                        // A preset whose entire feature set is compiled out
                        // (e.g. Minimal Code Editor — fileExplorer + terminal —
                        // in a lite build without either) would zero out the
                        // active set if applied; FeatureRegistry.applyPreset
                        // already refuses that, but offering it in the menu is
                        // still noise, so it's dropped here too. Custom always
                        // stays — it has no fixed feature set to intersect.
                        ForEach(ProfilePreset.allCases.filter { preset in
                            preset == .custom || !preset.features.isDisjoint(with: registry.compiledFeatures)
                        }) { preset in
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
                    // A section backed by a feature that isn't compiled into
                    // this build must not be offered — it would open onto the
                    // "not installed" placeholder every launch. Same
                    // section → feature mapping AppShell's toolbar filter
                    // uses (ShellState.Section.backingFeature).
                    ForEach(ShellState.Section.allCases.filter { section in
                        guard section != .settings, section != .live else { return false }
                        guard let feature = section.backingFeature else { return true }
                        return registry.compiledFeatures.contains(feature)
                    }, id: \.self) { section in
                        Text(section.label).tag(section.rawValue)
                    }
                }
                .pickerStyle(.menu)
                .padding(.bottom, Spacing.xs)

                // Drop rows for a section whose backingFeature isn't compiled
                // into this build — a hide/show switch for a button that can
                // never appear (compiled out entirely) is noise, unlike a
                // merely-disabled feature which the user might re-enable.
                let hideable = ShellState.Section.userHideable.filter { section in
                    section.backingFeature.map { registry.compiledFeatures.contains($0) } ?? true
                }
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
        // Kept in the list (not filtered out) even when not compiled in, so
        // users on a slimmer edition can see the feature exists rather than
        // silently missing from Workspace.
        let installed = registry.compiledFeatures.contains(feature)
        let binding = Binding<Bool>(
            get: { registry.isEnabled(feature) },
            set: { isEnabled in
                var updated = registry.activeFeatures
                if isEnabled {
                    updated.insert(feature)
                } else {
                    updated.remove(feature)
                }
                registry.updateFeatureSet(updated)
            }
        )
        HStack(spacing: Spacing.md) {
            Image(systemName: feature.systemImage)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(installed ? t.accent2 : t.textMuted)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(feature.displayName)
                    .font(Typography.body)
                    .foregroundStyle(installed ? t.text : t.textMuted)
                if !feature.requiredDependencies.isEmpty {
                    Text("Requires \(feature.requiredDependencies.map(\.displayName).joined(separator: ", "))")
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                }
            }
            Spacer()
            if installed {
                Toggle("", isOn: binding)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .labelsHidden()
                    .help(binding.wrappedValue ? "Disable \(feature.displayName)" : "Enable \(feature.displayName)")
            } else {
                Text("Not installed")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
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

/// "Apply & Rebuild" — only ever mounted (by `FeatureProfileSettingsSection`)
/// when `FeatureRebuildService.isEligible`, so every path in this view can
/// assume a real `sourceRoot`/`installTarget` exist. Drives the full
/// stage → confirm → swap-and-relaunch flow described in
/// `docs/spec/macos-app.md` ("Apply & Rebuild").
struct BuildRebuildSettingsCard: View {
    @EnvironmentObject var rebuild: FeatureRebuildService
    @EnvironmentObject var theme: ThemeStore
    @State private var showConfirmation = false

    var body: some View {
        SettingsSectionCard(icon: "hammer", title: "Build") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint(
                    "Rebuild this app from source with only the enabled features above compiled in — a genuinely lighter binary, not just hidden menus."
                )

                let compiled = rebuild.compiledSet
                statusRow("Compiled into this binary",
                          compiled.map(\.displayName).sorted().joined(separator: ", "))
                statusRow("Built with", rebuild.builtFeaturesRaw ?? "all")

                if FeatureRebuildService.hasDrift(compiled: compiled, active: FeatureRegistry.shared.activeFeatures) {
                    SettingsHint("This binary's compiled feature set differs from your current selection — rebuild to apply.")
                }

                Divider().padding(.vertical, Spacing.xs)

                phaseContent
            }
        }
        .confirmationDialog(
            "Rebuild and replace this app?",
            isPresented: $showConfirmation
        ) {
            Button("Apply & Rebuild") { rebuild.startRebuild() }
        } message: {
            Text(confirmationMessage)
        }
    }

    private var confirmationMessage: String {
        var message = "This rebuilds \(L.App.name) from source with the enabled feature set above, then replaces the running app and relaunches it. The previous version is kept as a .bak file for rollback."
        if !rebuild.hasStableSignIdentity {
            message += " Ad-hoc signing changes the app's code identity — macOS will re-prompt for keychain access and you may need to sign in again; run Scripts/make-dev-cert.sh once to avoid this."
        }
        return message
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch rebuild.phase {
        case .idle:
            applyButton

        case .building, .swapping:
            // .swapping is the instant between "spawn rebuild-swap.sh" and
            // this process actually dying under NSApp.terminate — treated
            // identically to .building (progress, no readyToSwap
            // affordance): there is no further phase transition to react to
            // on success since the app quits.
            HStack(spacing: Spacing.sm) {
                ProgressView().controlSize(.small)
                Text(rebuild.phase == .swapping ? "Restarting…" : "Rebuilding…")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
            }
            if !rebuild.logTail.isEmpty {
                logTailView
            }

        case .readyToSwap:
            VStack(alignment: .leading, spacing: Spacing.sm) {
                statusRow("Status", "Build ready", ok: true)
                HStack {
                    Spacer()
                    Button("Restart & Install") { rebuild.swapAndRelaunch() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }

        case .failed(let message):
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text(message)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                HStack {
                    Spacer()
                    // Retry goes through the same confirmation as a fresh
                    // Apply — the constraint that startRebuild() is never
                    // reached without it holds for every entry point, not
                    // just the first attempt.
                    Button("Retry") { showConfirmation = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
    }

    private var applyButton: some View {
        HStack {
            Spacer()
            Button("Apply & Rebuild (remove disabled code)") { showConfirmation = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
    }

    private var logTailView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(rebuild.logTail.enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 120)
        .padding(Spacing.xs)
        .background(theme.current.body.opacity(0.5))
        .cornerRadius(4)
    }

    private func statusRow(_ label: String, _ value: String, ok: Bool = true) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Text(label)
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
            Spacer()
            Text(value)
                .font(Typography.body)
                .foregroundStyle(theme.current.text)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
