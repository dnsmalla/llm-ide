import SwiftUI

/// App-wide Loop defaults for **new** projects — lives on the Loop page, not Settings.
struct LoopNewProjectDefaultsPanel: View {
    @EnvironmentObject var theme: ThemeStore

    @State private var defaults = LoopEngineConfig(stages: [])
    @State private var templateCount = (builtIn: 0, saved: 0)
    @State private var isExpanded = false
    @State private var timeouts = LoopEngineDefaults.stageTimeouts()

    var body: some View {
        let t = theme.current
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("A project that has already been opened in the Loop keeps its own settings — these apply the first time a project's stages are detected.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                LoopBudgetsEditor(maxIterations: $defaults.maxIterations,
                                  consecutiveFailureStop: $defaults.consecutiveFailureStop,
                                  wallClockMinutes: LoopBudgetsEditor.wallClockMinutes($defaults),
                                  maxRepairsPerStage: $defaults.maxRepairsPerStage)

                Text("If a repair edits a test, build file, or system/")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
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
                        .foregroundStyle(t.accent4)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text("Default stage timeouts (minutes, 0 = no limit) — used when a stage sets none")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                HStack {
                    Stepper("Shell \(timeouts.shellSeconds / 60)", value: minutesBinding(\.shellSeconds),
                            in: 0...720, step: 5)
                    Stepper("Agent \(timeouts.agentSeconds / 60)", value: minutesBinding(\.agentSeconds),
                            in: 0...720, step: 5)
                }

                Toggle("Write a run summary note to the Library", isOn: $defaults.writeSummaryNote)
                    .font(Typography.caption)

                HStack {
                    Text("Templates")
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                    Spacer()
                    Text(templateCount.saved == 0
                            ? "\(templateCount.builtIn) built-in"
                            : "\(templateCount.builtIn) built-in · \(templateCount.saved) saved")
                        .font(Typography.caption)
                        .foregroundStyle(t.text)
                }
            }
            .font(Typography.caption)
            .padding(.top, Spacing.xs)
            .onChange(of: defaults) { _, updated in
                LoopEngineDefaults.save(updated)
            }
        } label: {
            Text("New project defaults")
                .font(Typography.captionStrong)
                .foregroundStyle(t.textMuted)
        }
        .onAppear {
            timeouts = LoopEngineDefaults.stageTimeouts()
            defaults = LoopEngineDefaults.load()
            let store = LoopTemplateStore()
            templateCount = (LoopTemplate.builtIns.count, store.customTemplates.count)
        }
    }

    private func minutesBinding(_ keyPath: WritableKeyPath<LoopEngineDefaults.StageTimeouts, Int>) -> Binding<Int> {
        Binding(get: { timeouts[keyPath: keyPath] / 60 },
                set: { timeouts[keyPath: keyPath] = $0 * 60
                       LoopEngineDefaults.saveStageTimeouts(timeouts) })
    }
}
