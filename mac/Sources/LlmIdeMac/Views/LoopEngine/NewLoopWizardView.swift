// New Loop wizard — the top-level "create a loop" flow.
//
// Distinct from two existing, easy-to-confuse controls on this page:
//   - the stages pane's `+` adds ONE bare stage to whatever config is
//     already loaded (no skill/target set, no template involved);
//   - the TEMPLATE section's Picker + Apply overwrites the current config
//     with a template's stages exactly as shipped, silently leaving any
//     `.skill` stage's skillId/targetPath unset.
//
// This is the "I don't know this page yet, give me a working loop" path:
// pick a recipe (or don't — a template is a starting point, not a
// requirement), add stages one at a time with the same "+" affordance the
// main page uses, wire in each generate stage's skill/input/output, decide
// whether it should leave a summary note, then create it. Input/output are
// `PathPickerField`s scoped to the project root (browse or type any path,
// not just items already curated into the Library) — see LoopStage.targetPath
// /outputPath and LoopEngineRunner.composeSkillMessage for how they're used.
//
// "Save as Template" is what makes a configured process (skill + input +
// output) a reusable, editable recipe instead of a one-off: without it, the
// skill/input choices made here only ever land in the current project's
// active config (via Create Loop) and picking the same built-in again next
// time starts blank, because every built-in ships with skillId/targetPath
// unset by design — see LoopTemplate.skillLoop/docsRefresh.

import SwiftUI

struct NewLoopWizardView: View {
    @ObservedObject var templateStore: LoopTemplateStore
    let skillCatalog: [LlmIdeAPIClient.SkillLibraryEntry]
    let gitRoot: URL?
    /// Receives the finished config; the caller applies it to the active
    /// project's loop and persists it (creating IS the confirmation here,
    /// unlike Apply in the Template section which stages an edit for Save).
    let onCreate: (LoopEngineConfig) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore

    @State private var selectedTemplateId: UUID?
    @State private var stages: [LoopStage] = []
    /// Set when the selected template's stages were all `detectedTestCommand`
    /// placeholders and none resolved — the reason `stages` is empty is "no
    /// test tooling found here", not "nothing configured yet". Cleared as
    /// soon as the user takes manual control by adding a stage.
    @State private var noToolingDetectedForTemplate = false
    /// Budgets, policy, and the output toggle for the config being assembled:
    /// the selected template's when one is chosen, else the same app-wide
    /// defaults a brand-new project gets. Held as a genuinely stage-less
    /// `LoopEngineConfig` — stages live ONLY in `stages` above, so there is no
    /// second stage list to leak template placeholders — and the Output toggle
    /// binds `budgets.writeSummaryNote` directly, so deselecting a template
    /// resets it along with everything else.
    @State private var budgets = LoopEngineDefaults.newConfig(stages: [])
    @State private var isNamingTemplate = false
    @State private var newTemplateName = ""
    @State private var newTemplateSummary = ""

    private var selectedTemplate: LoopTemplate? {
        selectedTemplateId.flatMap { id in templateStore.templates.first { $0.id == id } }
    }

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 0) {
            Text("New Loop")
                .font(Typography.title)
                .padding(Spacing.lg)
            Divider().background(t.border)
            HSplitView {
                templateList
                    .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)
                configurePane
                    .frame(minWidth: 360, maxWidth: .infinity)
            }
            Divider().background(t.border)
            HStack {
                Text("Create Loop applies + saves this project's active loop. Save as Template "
                    + "keeps the skill/input/output you set here as a reusable recipe.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save as Template") {
                    newTemplateName = selectedTemplate?.name ?? ""
                    newTemplateSummary = selectedTemplate?.summary ?? ""
                    isNamingTemplate = true
                }
                .buttonStyle(.bordered)
                .disabled(stages.isEmpty)
                // Gated on an ENABLED stage existing, not just any stage — a
                // template can carry every stage disabled, and creating that
                // loop could only ever produce the runner's refusal error.
                Button("Create Loop") { create() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!stages.contains(where: \.enabled))
            }
            .padding(Spacing.lg)
        }
        .frame(minWidth: 680, minHeight: 460)
        .background(t.body)
        .alert("Save as template", isPresented: $isNamingTemplate) {
            TextField("Name", text: $newTemplateName)
            TextField("What does this loop do?", text: $newTemplateSummary)
            Button("Save") { saveAsTemplate() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Saves the current stages — including any skill and input you set — as a "
                + "reusable recipe, available in every project and editable later.")
        }
    }

    // MARK: - Template list

    private var templateList: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel("TEMPLATE").padding(.horizontal, Spacing.lg).padding(.top, Spacing.md)
            List(selection: $selectedTemplateId) {
                Section("Built-in") {
                    ForEach(LoopTemplate.builtIns) { template in
                        templateRow(template)
                    }
                }
                if !templateStore.customTemplates.isEmpty {
                    Section("My templates") {
                        ForEach(templateStore.customTemplates) { template in
                            templateRow(template)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
        .onChange(of: selectedTemplateId) { _, newValue in
            guard let template = newValue.flatMap({ id in templateStore.templates.first { $0.id == id } })
            else {
                stages = []
                noToolingDetectedForTemplate = false
                budgets = LoopEngineDefaults.newConfig(stages: [])
                return
            }
            // One `applied(to:)` call, not two — `wouldApplyEmpty` would run
            // the same LoopStageDetector probing a second time for no reason.
            let applied = template.applied(to: gitRoot)
            noToolingDetectedForTemplate = !template.config.stages.isEmpty && applied.stages.isEmpty
            stages = applied.stages
            var templateBudgets = template.config
            templateBudgets.stages = []
            budgets = templateBudgets
        }
    }

    @ViewBuilder
    private func templateRow(_ template: LoopTemplate) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 2) {
            Text(template.name).font(Typography.filename)
            Text(template.summary)
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .lineLimit(2)
        }
        .tag(template.id)
    }

    // MARK: - Configure pane

    /// Stages are never gated behind picking a template first: a template is
    /// just a convenient starting point, and "+" adds ONE stage at a time to
    /// whatever's here, template-derived or not — so a fully custom process
    /// can be built from nothing without ever selecting a recipe.
    @ViewBuilder
    private var configurePane: some View {
        let t = theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                HStack {
                    SectionLabel("STAGES")
                    Spacer()
                    Menu {
                        Button("Shell command") { addStage(.shellCommand) }
                        Button("Regression sweep") { addStage(.regressionSweep) }
                        Button("Skill (generate)") { addStage(.skill) }
                    } label: {
                        Label("Add stage", systemImage: "plus")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                if stages.isEmpty && noToolingDetectedForTemplate {
                    Text("No test tooling detected in this project, so this template has nothing to run. Pick another template, or add a stage manually with +.")
                        .font(Typography.body)
                        .foregroundStyle(t.accent4)
                } else if stages.isEmpty {
                    Text("No stages yet. Pick a template on the left, or add stages one at a time with +.")
                        .font(Typography.body)
                        .foregroundStyle(t.textMuted)
                } else {
                    // Element bindings, NOT `ForEach(stages.indices, id: \.self)`
                    // — index identity re-binds every row below a removed one to
                    // the wrong stage mid-render (a focused TextField bound to
                    // `$stages[index]` can then read past the end and crash on
                    // the last row's removal). `$stages` gives stable id
                    // identity and a direct binding, with no per-row lookup.
                    ForEach($stages) { $stage in
                        stageConfigCard(stage: $stage)
                    }
                }
                Divider().background(t.border)
                SectionLabel("BUDGETS")
                Text("A run stops at whichever it hits first.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                LoopBudgetsEditor(maxIterations: $budgets.maxIterations,
                                  consecutiveFailureStop: $budgets.consecutiveFailureStop,
                                  wallClockMinutes: LoopBudgetsEditor.wallClockMinutes($budgets),
                                  maxRepairsPerStage: $budgets.maxRepairsPerStage)
                    .font(Typography.caption)
                Divider().background(t.border)
                SectionLabel("OUTPUT")
                Toggle("Write a run summary note to the Library", isOn: $budgets.writeSummaryNote)
                    .font(Typography.caption)
                Text("A readable markdown summary per run under llm-doc/loop/. The run "
                    + "journal (system/loop-runs/) always records every run regardless.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Spacing.lg)
        }
    }

    private func addStage(_ kind: LoopStage.Kind) {
        let nextOrder = (stages.map(\.order).max() ?? -1) + 1
        let name = switch kind {
        case .shellCommand: "New Stage"
        case .regressionSweep: "Regression"
        case .skill: "New Skill Stage"
        }
        stages.append(LoopStage(name: name, kind: kind,
                                 command: kind == .shellCommand ? "" : nil, order: nextOrder))
        noToolingDetectedForTemplate = false
    }

    @ViewBuilder
    private func stageConfigCard(stage: Binding<LoopStage>) -> some View {
        let t = theme.current
        let s = stage.wrappedValue
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: 6) {
                Image(systemName: s.kind == .regressionSweep ? "arrow.uturn.backward.circle"
                      : s.kind == .shellCommand ? "terminal" : "sparkles")
                    .foregroundStyle(t.textMuted)
                TextField("Stage name", text: stage.name)
                    .textFieldStyle(.roundedBorder)
                    .font(Typography.bodyStrong)
                    .frame(maxWidth: 220)
                Spacer()
                // Templates carry `enabled` through (a recipe with a
                // deliberately-off stage is meaningful), so the wizard must
                // both SHOW that state and let the user flip it — otherwise a
                // template saved with a disabled stage is invisible dead
                // weight in every project it's applied to.
                Toggle("", isOn: stage.enabled)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .help(s.enabled ? "Enabled — runs every iteration"
                          : "Disabled — the runner skips this stage")
                Button {
                    stages.removeAll { $0.id == s.id }
                } label: {
                    Image(systemName: "trash")
                        .foregroundStyle(t.textMuted)
                }
                .buttonStyle(.borderless)
                .help("Remove this stage")
            }

            switch s.kind {
            case .skill:
                Text("Skill").font(Typography.caption).foregroundStyle(t.textMuted)
                if skillCatalog.isEmpty {
                    Text("No library skills found.")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                } else {
                    Picker("Skill", selection: Binding(
                        get: { stage.wrappedValue.skillId ?? "" },
                        set: { stage.wrappedValue.skillId = $0.isEmpty ? nil : $0 }
                    )) {
                        Text("None").tag("")
                        ForEach(skillCatalog) { s in
                            Text("\(s.name) · \(s.family)").tag(s.id)
                        }
                    }
                    .labelsHidden()
                }

                Text("Input (optional) — file or folder under the project root").font(Typography.caption).foregroundStyle(t.textMuted)
                PathPickerField(root: gitRoot, path: stage.targetPath)

                Text("Output (optional) — where the skill should write its result").font(Typography.caption).foregroundStyle(t.textMuted)
                PathPickerField(root: gitRoot, path: stage.outputPath)

                Text("Prompt (optional)").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("Defaults to: apply this skill", text: Binding(
                    get: { stage.wrappedValue.prompt ?? "" },
                    set: { stage.wrappedValue.prompt = $0.isEmpty ? nil : $0 }
                ), axis: .vertical)
                .textFieldStyle(.roundedBorder)
            case .shellCommand:
                Text("Command").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("e.g. swift test", text: Binding(
                    get: { stage.wrappedValue.command ?? "" },
                    set: { stage.wrappedValue.command = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, design: .monospaced))
            case .regressionSweep:
                Text("Re-runs the fault sweep (known regressions + repo checks) against this project.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }

            // Same meaning as the Loop page's Severity picker; segmented and
            // inline so the wizard can configure everything the page can.
            Picker("Severity", selection: stage.severity) {
                ForEach(LoopStageSeverity.allCases, id: \.self) { severity in
                    Text(severity.label).tag(severity)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 220)
            .help("Blocking: a failure triggers repair and can end the run. Advisory: recorded only — use for linters and formatters.")
        }
        .padding(Spacing.sm)
        .background(t.surface)
        .cornerRadius(6)
        .opacity(s.enabled ? 1 : 0.55)
    }

    // MARK: - Create / Save as template

    /// The config as currently configured in this wizard — same stages either
    /// path uses, so Create Loop and Save as Template can never disagree about
    /// what was actually set up. Budgets are whatever the BUDGETS section shows
    /// (seeded from the selected template, else the app-wide defaults) — a
    /// template is a convenient starting point, never a requirement, since
    /// `stages` can equally have been built from nothing via "+".
    private func configuredConfig() -> LoopEngineConfig {
        var config = budgets
        config.stages = stages
        return config
    }

    private func create() {
        guard stages.contains(where: \.enabled) else { return }
        onCreate(configuredConfig())
        dismiss()
    }

    /// Persists the configured process as a new custom template — the point
    /// being that the skill/input choices made in this session survive to the
    /// next one, unlike the ones applied via `create()` alone.
    private func saveAsTemplate() {
        guard !stages.isEmpty else { return }
        let saved = templateStore.save(
            name: newTemplateName, summary: newTemplateSummary, config: configuredConfig())
        selectedTemplateId = saved.id
        newTemplateName = ""
        newTemplateSummary = ""
    }
}
