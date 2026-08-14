// Loop Engineering detail pane (panel 2) — the loop's contract, in one scroll:
//
//   OVERVIEW   what this run will do, in order, and where it will do it
//   TEMPLATE   pick a recipe, or save this stage list as one
//   PROCESS    every stage as its own editable card (in LoopEngineView.swift,
//              next to stageDetail/processCard) — no stage hidden behind a
//              selection
//   SETTINGS   the four budgets + the protected-path policy
//   OUTPUT     every artifact a run writes, with a link, plus the summary note
//
// Panel 1 is the stage list; panel 3 is the live log + past runs. Sections here
// are computed views only — all @State lives in LoopEngineView.swift, since a
// SwiftUI extension cannot declare storage.

import SwiftUI

extension LoopEngineView {

    // MARK: - Overview

    /// Answers "what will this loop do, and where" without the user having to
    /// click each stage in turn. The pipeline is rendered in the runner's real
    /// execution order, with each stage's role (generate vs verify) and whether
    /// it actually gates the run.
    @ViewBuilder
    var overviewSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("OVERVIEW")

            if stages.isEmpty {
                Text("No stages yet. Apply a template below, or add a stage with + on the left.")
                    .font(Typography.body)
                    .foregroundStyle(t.textMuted)
            } else {
                Text(pipelineSummary)
                    .font(Typography.body)
                    .foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)

                // Numbered by RUN position (disabled stages get "–"), so the
                // printed numbers line up with the order the log will show —
                // a disabled stage must not shift every later stage's number.
                let ordered = sortedStages
                let runNumbers = Dictionary(uniqueKeysWithValues:
                    ordered.filter(\.enabled).enumerated().map { ($0.element.id, $0.offset + 1) })
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(ordered) { stage in
                        overviewRow(index: runNumbers[stage.id], stage: stage)
                    }
                }
                .padding(.top, 2)
            }

            // "Where it implements" — the two roots are genuinely different in the
            // clone-into-code layout, and a user who assumes one is the other will
            // misread every path in the Output section below.
            VStack(alignment: .leading, spacing: 2) {
                overviewFact("Runs in", activeGitRootURL?.path ?? "no git working tree resolved",
                             warn: activeGitRootURL == nil)
                if let projectRoot = workspaceContext?.projectRoot,
                   projectRoot.path != activeGitRootURL?.path {
                    overviewFact("Project root", projectRoot.path)
                }
                overviewFact("Bounded by", budgetSummary)
            }
            .padding(.top, 4)
        }
    }

    /// One pipeline row: run position (`nil` for a disabled stage), name, role,
    /// and what it actually executes.
    @ViewBuilder
    private func overviewRow(index: Int?, stage: LoopStage) -> some View {
        let t = theme.current
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(index.map(String.init) ?? "–")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(t.textMuted)
                .frame(width: 14, alignment: .trailing)
            Text(stage.name)
                .font(Typography.body)
                .foregroundStyle(stage.id == selectedStageId ? t.accent : t.text)
            badge(stage.kind == .skill ? "generate" : "verify",
                  color: stage.kind == .skill ? t.accent2 : t.accent)
            if !stage.enabled {
                badge("off", color: t.textMuted)
            }
            if stage.severity == .advisory {
                badge("advisory", color: t.textMuted)
            }
            Text(stageExecutionDetail(stage))
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(t.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
        }
    }

    /// What the stage will actually run, or the reason it cannot.
    private func stageExecutionDetail(_ stage: LoopStage) -> String {
        guard stage.enabled else { return "disabled — skipped" }
        switch stage.kind {
        case .regressionSweep:
            return "system/faults/"
        case .shellCommand:
            let command = stage.command?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if command.isEmpty { return "no command set" }
            guard let gitRoot = activeGitRootURL else { return command }
            // Approval is a real precondition, not a nicety: an unapproved stage
            // stops the run in preflight before any iteration.
            return approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command)
                ? command
                : "\(command) — needs approval"
        case .skill:
            guard let skillId = stage.skillId, !skillId.isEmpty else { return "no skill chosen" }
            return stage.targetPath.map { "\(skillId) → \($0)" } ?? skillId
        }
    }

    @ViewBuilder
    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    @ViewBuilder
    private func overviewFact(_ label: String, _ value: String, warn: Bool = false) -> some View {
        let t = theme.current
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .frame(width: 86, alignment: .leading)
            Text(value)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(warn ? t.danger : t.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One sentence naming the generate/verify shape of the run, so the pipeline
    /// list below has a frame to sit in.
    private var pipelineSummary: String {
        // Disabled stages take no part in a run, so they must not count toward
        // the shape — a summary claiming "3 gating checks" when two are off
        // would misdescribe the run this pane exists to describe.
        let active = sortedStages.filter(\.enabled)
        let verify = active.filter { $0.kind != .skill && $0.severity == .blocking }.count
        let generate = active.filter { $0.kind == .skill }.count
        let advisory = active.filter { $0.severity == .advisory }.count
        let disabled = sortedStages.count - active.count

        var parts: [String] = []
        if generate > 0 { parts.append("\(generate) generate step\(generate == 1 ? "" : "s")") }
        parts.append("\(verify) gating check\(verify == 1 ? "" : "s")")
        if advisory > 0 { parts.append("\(advisory) advisory") }
        if disabled > 0 { parts.append("\(disabled) disabled") }
        let shape = parts.joined(separator: " · ")

        if active.isEmpty {
            return "\(shape). Every stage is disabled — the run will refuse to start until one is enabled."
        }
        if verify == 0 {
            // Worth saying plainly: with nothing gating, the loop cannot fail and
            // therefore cannot repair — it will report success after one pass.
            return "\(shape). Nothing gates this run, so it will pass after one iteration without repairing anything."
        }
        return "\(shape). Every iteration re-runs all stages from the top until each gating check passes."
    }

    private var budgetSummary: String {
        let time = wallClockMinutes == 0 ? "no time limit" : "\(wallClockMinutes) min"
        return "\(maxIterations) iterations · \(time) · stop after \(consecutiveFailureStop) non-improving · \(maxRepairsPerStage) repairs/stage"
    }

    // MARK: - Template

    @ViewBuilder
    var templateSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("TEMPLATE")

            HStack(spacing: Spacing.sm) {
                Picker("", selection: $selectedTemplateId) {
                    Text("Choose a recipe…").tag(UUID?.none)
                    Section("Built-in") {
                        ForEach(LoopTemplate.builtIns) { template in
                            Text(template.name).tag(Optional(template.id))
                        }
                    }
                    if !templateStore.customTemplates.isEmpty {
                        Section("My templates") {
                            ForEach(templateStore.customTemplates) { template in
                                Text(template.name).tag(Optional(template.id))
                            }
                        }
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 240)

                Button("Apply") { applySelectedTemplate() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(selectedTemplate == nil)
                Button("Save as…") { isNamingTemplate = true }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(stages.isEmpty)
                if let selected = selectedTemplate, !selected.isBuiltIn {
                    Button("Delete", role: .destructive) {
                        templateStore.delete(id: selected.id)
                        selectedTemplateId = nil
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                Spacer()
            }

            if let selected = selectedTemplate {
                Text(selected.summary)
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                Text(LoopStage.runOrder(selected.config.stages)
                        .map { $0.enabled ? $0.name : "\($0.name) (off)" }
                        .joined(separator: " → "))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                // Applying replaces the stage list wholesale, which also drops the
                // approvals keyed to the old stage ids — say so before the click,
                // not after.
                Text("Applying replaces the current stages and budgets and saves shortly after. Shell stages will need approving again.")
                    .font(Typography.caption)
                    .foregroundStyle(t.accent4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .alert("Save as template", isPresented: $isNamingTemplate) {
            TextField("Name", text: $newTemplateName)
            TextField("What does this loop do?", text: $newTemplateSummary)
            Button("Save") { saveCurrentAsTemplate() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Saves the current stages and budgets as a reusable recipe, available in every project.")
        }
    }

    // MARK: - Settings

    @ViewBuilder
    var settingsSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("SETTINGS")

            Text("Budgets — a run stops at whichever it hits first.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
            LoopBudgetsEditor(maxIterations: $maxIterations,
                              consecutiveFailureStop: $consecutiveFailureStop,
                              wallClockMinutes: $wallClockMinutes,
                              maxRepairsPerStage: $maxRepairsPerStage)
            Text("A non-improving failure is one whose failing-test count did not shrink; for runners we can't parse, one whose output is unchanged.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            Divider().background(t.border).padding(.vertical, 2)

            Text("If a repair edits a test, build file, or system/")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
            Picker("", selection: $protectedPathPolicy) {
                ForEach(ProtectedPathPolicy.allCases, id: \.self) { policy in
                    Text(policy.label).tag(policy)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            Text(protectedPolicyExplanation)
                .font(Typography.caption)
                .foregroundStyle(protectedPathPolicy == .off ? t.accent4 : t.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: Spacing.sm) {
                Button("Save") { saveConfig() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Text("Changes save automatically; Save writes immediately — including states autosave skips, like an emptied stage list.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            .padding(.top, 2)
        }
        .font(Typography.caption)
    }

    private var protectedPolicyExplanation: String {
        switch protectedPathPolicy {
        case .revert:
            return "The edit is undone and the run stops as blocked. A stage that only passed because of such an edit is never reported as fixed."
        case .stop:
            return "The edit is left in place for you to inspect and the run stops as blocked."
        case .warn:
            return "The edit is logged and the run keeps going — the stage may then pass because of it."
        case .off:
            return "No check at all. A repair can delete the failing test and the run will report success."
        }
    }

    // MARK: - Output

    /// Answers "what does this produce". Every row is a real path, and every row
    /// that exists on disk can be opened — the point is that a run's results are
    /// findable, not described.
    @ViewBuilder
    var outputSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("OUTPUT")

            if let projectRoot = workspaceContext?.projectRoot {
                outputRow(label: "Run journal",
                          detail: "system/loop-runs/ — one JSON record per run, plus an index",
                          url: FileLoopRunJournal.runsDirectory(root: projectRoot))
                outputRow(label: "Fault state",
                          detail: "system/faults.csv — refreshed by the Regression stage",
                          url: projectRoot.appendingPathComponent("system/faults.csv"))
            }
            if let gitRoot = activeGitRootURL {
                outputRow(label: "Working tree",
                          detail: "repair edits land here — review with git before committing",
                          url: gitRoot)
            }
            outputRow(label: "Run log", detail: "live, in the panel to the right", url: nil)

            Divider().background(t.border).padding(.vertical, 2)

            Toggle("Write a run summary note to the Library", isOn: $writeSummaryNote)
                .font(Typography.caption)
            Text("A readable markdown summary per run — outcome, pipeline, per-stage results, files changed — under llm-doc/loop/. The journal above always records every run regardless.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if writeSummaryNote, let projectRoot = workspaceContext?.projectRoot {
                outputRow(label: "Summary notes",
                          detail: lastSummaryNoteName ?? "none written yet",
                          url: projectRoot.appendingPathComponent("llm-doc/loop"))
            }
        }
    }

    @ViewBuilder
    private func outputRow(label: String, detail: String, url: URL?) -> some View {
        let t = theme.current
        let exists = url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .frame(width: 96, alignment: .leading)
            Text(detail)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(t.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            if let url, exists {
                Button("Reveal") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    .buttonStyle(.borderless)
                    .font(Typography.caption)
            } else if url != nil {
                // Distinguish "nothing has written this yet" from "this is not an
                // output of the loop at all" — both are fine, but they differ.
                Text("not yet")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
        }
    }
}
