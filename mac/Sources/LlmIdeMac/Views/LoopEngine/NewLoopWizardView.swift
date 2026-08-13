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
    @State private var writeSummaryNote = false
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
                Button("Create Loop") { create() }
                    .buttonStyle(.borderedProminent)
                    .disabled(stages.isEmpty)
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
                return
            }
            // One `applied(to:)` call, not two — `wouldApplyEmpty` would run
            // the same LoopStageDetector probing a second time for no reason.
            let applied = template.applied(to: gitRoot)
            noToolingDetectedForTemplate = !template.config.stages.isEmpty && applied.stages.isEmpty
            stages = applied.stages
            writeSummaryNote = template.config.writeSummaryNote
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
                    ForEach(stages.indices, id: \.self) { index in
                        stageConfigCard(index: index)
                    }
                }
                Divider().background(t.border)
                SectionLabel("OUTPUT")
                Toggle("Write a run summary note to the Library", isOn: $writeSummaryNote)
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
    private func stageConfigCard(index: Int) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: 6) {
                Image(systemName: stages[index].kind == .regressionSweep ? "arrow.uturn.backward.circle"
                      : stages[index].kind == .shellCommand ? "terminal" : "sparkles")
                    .foregroundStyle(t.textMuted)
                Text(stages[index].name).font(Typography.bodyStrong)
                Spacer()
                Button {
                    stages.remove(at: index)
                } label: {
                    Image(systemName: "trash")
                        .foregroundStyle(t.textMuted)
                }
                .buttonStyle(.borderless)
                .help("Remove this stage")
            }

            switch stages[index].kind {
            case .skill:
                Text("Skill").font(Typography.caption).foregroundStyle(t.textMuted)
                if skillCatalog.isEmpty {
                    Text("No library skills found.")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                } else {
                    Picker("Skill", selection: Binding(
                        get: { stages[index].skillId ?? "" },
                        set: { stages[index].skillId = $0.isEmpty ? nil : $0 }
                    )) {
                        Text("None").tag("")
                        ForEach(skillCatalog) { s in
                            Text("\(s.name) · \(s.family)").tag(s.id)
                        }
                    }
                    .labelsHidden()
                }

                Text("Input (optional) — file or folder under the project root").font(Typography.caption).foregroundStyle(t.textMuted)
                PathPickerField(root: gitRoot, path: $stages[index].targetPath)

                Text("Output (optional) — where the skill should write its result").font(Typography.caption).foregroundStyle(t.textMuted)
                PathPickerField(root: gitRoot, path: $stages[index].outputPath)
            case .shellCommand:
                Text("Command").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("e.g. swift test", text: Binding(
                    get: { stages[index].command ?? "" },
                    set: { stages[index].command = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, design: .monospaced))
            case .regressionSweep:
                Text("Re-runs the fault sweep (known regressions + repo checks) against this project.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
        }
        .padding(Spacing.sm)
        .background(t.surface)
        .cornerRadius(6)
    }

    // MARK: - Create / Save as template

    /// The config as currently configured in this wizard — same stages either
    /// path uses, so Create Loop and Save as Template can never disagree about
    /// what was actually set up. Budgets come from the selected template when
    /// there is one, else the same app-wide defaults a brand-new project gets
    /// — a template is a convenient starting point, never a requirement, since
    /// `stages` can equally have been built from nothing via "+".
    private func configuredConfig() -> LoopEngineConfig {
        var config = selectedTemplate?.config ?? LoopEngineDefaults.newConfig(stages: [])
        config.stages = stages
        config.writeSummaryNote = writeSummaryNote
        return config
    }

    private func create() {
        guard !stages.isEmpty else { return }
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
