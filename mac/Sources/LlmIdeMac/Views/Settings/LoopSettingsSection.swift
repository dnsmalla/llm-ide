import SwiftUI

/// Settings card for the Loop: the budgets and policy a **new** project inherits,
/// plus a way into the Loop workspace itself.
///
/// Scoped to defaults on purpose. The Loop page is a three-pane workspace whose
/// stage list is per-project and detected from that repo's test tooling, so it
/// cannot live inside a Settings card — and duplicating the per-project editor
/// here would give two places to change one project's budgets, with no rule for
/// which wins. What Settings can usefully own is the starting point every new
/// project gets, which previously came from `LoopEngineConfig`'s hardcoded values
/// and could only be changed project by project after the fact.
struct LoopSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore

    /// The stage-less config acting as the template for new projects. Held in
    /// state and written back on change, so there is no Save button to forget.
    @State private var defaults = LoopEngineConfig(stages: [])
    @State private var templateCount = (builtIn: 0, saved: 0)

    var body: some View {
        SettingsSectionCard(icon: "repeat.circle", title: "Loop") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack {
                    Text("Defaults for new projects")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                    Button("Open Loop") {
                        // Same mechanism the menu-bar rows use to jump sections.
                        // `.openSection` sets the section directly and never consults
                        // the hidden set, so this stays the way back in after the Loop
                        // button has been hidden via Settings → Menu Bar.
                        NotificationCenter.default.post(
                            name: .openSection,
                            object: ShellState.Section.loopEngine.rawValue)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Opens the Loop page, even when its top-bar button is hidden.")
                }

                Text("A project that has already been opened in the Loop keeps its own settings — these apply the first time a project's stages are detected.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                Divider().padding(.vertical, 2)

                LoopBudgetsEditor(maxIterations: $defaults.maxIterations,
                                  consecutiveFailureStop: $defaults.consecutiveFailureStop,
                                  wallClockMinutes: LoopBudgetsEditor.wallClockMinutes($defaults),
                                  maxRepairsPerStage: $defaults.maxRepairsPerStage)

                Divider().padding(.vertical, 2)

                Text("If a repair edits a test, build file, or system/")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                Picker("", selection: $defaults.protectedPathPolicy) {
                    ForEach(ProtectedPathPolicy.allCases, id: \.self) { policy in
                        Text(policy.label).tag(policy)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                if defaults.protectedPathPolicy == .off {
                    Text("With no check, a repair can delete the failing test and the run will report success.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.accent4)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Divider().padding(.vertical, 2)

                Toggle("Write a run summary note to the Library", isOn: $defaults.writeSummaryNote)
                    .font(Typography.caption)

                HStack {
                    Text("Templates")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                    Text(templateCount.saved == 0
                            ? "\(templateCount.builtIn) built-in"
                            : "\(templateCount.builtIn) built-in · \(templateCount.saved) saved")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.text)
                }
            }
            .font(Typography.caption)
            .onChange(of: defaults) { _, updated in
                LoopEngineDefaults.save(updated)
            }
        }
        .onAppear {
            defaults = LoopEngineDefaults.load()
            // Read-only count: templates are managed on the Loop page, where the
            // stage list they describe is visible.
            let store = LoopTemplateStore()
            templateCount = (LoopTemplate.builtIns.count, store.customTemplates.count)
        }
    }
}
