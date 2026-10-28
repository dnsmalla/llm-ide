import SwiftUI

/// Settings → Agent history: how much agent history is stored, how long raw rows
/// are kept, clearing it (dry-run preview, then a confirmed clear), and compacting
/// the store. Registered in the `agentHistory` Settings slot by Shell
/// (`FeatureCatalog.registerSettingsSections`); it talks only to the API client.
struct AgentHistorySettingsCard: View {
    @EnvironmentObject var theme: ThemeStore
    @StateObject private var model: AgentHistoryModel
    @State private var clearScope: LlmIdeAPIClient.AgentHistoryClearScope = .raw

    init(api: LlmIdeAPIClient) {
        _model = StateObject(wrappedValue: AgentHistoryModel(api: api))
    }

    var body: some View {
        SettingsSectionCard(icon: "clock.arrow.circlepath", title: "Agent history") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Chat, Loop and meeting-agent runs are kept here. Clearing deletes the rows you pick after a preview of what will go; compacting gives back free disk space.")

                if let loadError = model.loadError {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Couldn't load agent history: \(loadError)")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.danger)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Retry") { Task { await model.load() } }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                }

                storageRows
                summaryLines

                Divider()
                retentionRow
                clearRow
                compactRow
            }
        }
        .task { await model.load() }
        .sheet(isPresented: Binding(
            get: { model.clearPhase.isPresented },
            set: { if !$0 { model.cancelClear() } }
        )) {
            ClearHistorySheet(model: model)
        }
    }

    // MARK: - Storage

    @ViewBuilder
    private var storageRows: some View {
        if let groups = model.report?.groups {
            ForEach(groups) { group in
                HStack(alignment: .firstTextBaseline) {
                    Text(group.label)
                        .font(Typography.body)
                        .foregroundStyle(theme.current.text)
                    Spacer()
                    Text(sizeText(group))
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .monospacedDigit()
                }
                if group.canClear, let cleaned = group.lastCleanedAt, let date = AgentHistoryDates.parse(cleaned) {
                    Text("Last cleaned \(date.formatted(date: .abbreviated, time: .shortened))")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
        } else if model.loadError == nil {
            ProgressView().controlSize(.small)
        }
    }

    private func sizeText(_ group: LlmIdeAPIClient.StorageGroup) -> String {
        guard let bytes = group.bytes else { return "\(group.rows) rows" }
        let size = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
        let approx = group.bytesApprox == true ? "about " : ""
        return "\(approx)\(size) · \(group.rows) rows"
    }

    @ViewBuilder
    private var summaryLines: some View {
        if let history = model.report?.agentHistory {
            VStack(alignment: .leading, spacing: 2) {
                if let from = history.rawFromDay {
                    Text("Raw rows from \(from): \(history.rawRows). Rolled-up days: \(history.rolledDays)\(history.oldestDay.map { ", oldest \($0)" } ?? "").")
                }
                if history.droppedRows > 0 {
                    Text("\(history.droppedRows) rows were dropped by the write queue since the store was created.")
                }
                if let quarantined = history.quarantinedAt {
                    Text("The store was reset after damage on \(quarantined).")
                        .foregroundStyle(theme.current.warning)
                }
            }
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        } else if let store = model.report?.agentStore, store.health == "down" {
            Text("The agent history store is down. Restart the backend to reopen it.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.danger)
        }
    }

    // MARK: - Retention

    @ViewBuilder
    private var retentionRow: some View {
        if let settings = model.settings {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack {
                    Stepper(
                        "Keep raw history for \(model.retentionDraft) days",
                        value: $model.retentionDraft,
                        in: model.retentionRange
                    )
                    .font(Typography.body)
                    Spacer()
                    Button("Save") { Task { await model.saveRetention() } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(!model.retentionChanged || model.savingRetention)
                }
                SettingsHint("Daily rollups are kept for \(settings.rollupKeepDays) days. Allowed: \(settings.min) to \(settings.max) days.")
                if let message = model.retentionMessage {
                    Text(message)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
        }
    }

    // MARK: - Clear

    private var clearRow: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Picker("Scope", selection: $clearScope) {
                    Text("Raw rows").tag(LlmIdeAPIClient.AgentHistoryClearScope.raw)
                    Text("Everything").tag(LlmIdeAPIClient.AgentHistoryClearScope.all)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: 220)
                Spacer()
                Button("Clear…") { Task { await model.beginClear(scope: clearScope) } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(model.clearPhase.isPresented)
            }
            SettingsHint(clearScope == .raw
                ? "Deletes the raw runs and tool events. Daily rollups stay."
                : "Deletes the raw runs and also the daily rollups.")
        }
    }

    // MARK: - Compact

    private var compactRow: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                SettingsHint("Compact gives back disk space left by deleted rows. It waits while a run is in progress.")
                Spacer()
                if model.compacting { ProgressView().controlSize(.small) }
                Button("Compact") { Task { await model.compact() } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(model.compacting)
            }
            if let message = model.compactMessage {
                Text(message)
                    .font(Typography.caption)
                    .foregroundStyle(model.compactIsError ? theme.current.warning : theme.current.success)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The Clear sheet: the dry run's counts, then one confirm button that sends the
/// preview's id. Nothing is deleted from this view except through `confirmClear`.
private struct ClearHistorySheet: View {
    @ObservedObject var model: AgentHistoryModel
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(title)
                .font(Typography.title)
                .foregroundStyle(theme.current.text)

            content

            if let notice = model.clearNotice {
                Text(notice)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                switch model.clearPhase {
                case let .confirming(_, preview):
                    Button("Cancel") { close() }
                        .keyboardShortcut(.cancelAction)
                    Button("Delete \(preview.total) rows") { Task { await model.confirmClear() } }
                        .buttonStyle(.borderedProminent)
                        .tint(theme.current.danger)
                        .disabled(preview.total == 0 || preview.previewId == nil)
                        .keyboardShortcut(.defaultAction)
                case .cleared, .failed:
                    Button("Done") { close() }
                        .keyboardShortcut(.defaultAction)
                case .previewing, .idle:
                    Button("Cancel") { close() }
                        .keyboardShortcut(.cancelAction)
                case .clearing:
                    EmptyView()
                }
            }
        }
        .padding(Spacing.lg)
        .frame(width: 420)
        // The real delete cannot be dismissed away: the sheet stays until the
        // server answers, so the result is never lost behind a closed sheet.
        .interactiveDismissDisabled(!model.canDismissClear)
    }

    private var title: String {
        switch model.clearPhase {
        case let .clearing(scope), let .previewing(scope), let .confirming(scope, _):
            return scope == .all ? "Clear all agent history" : "Clear raw agent history"
        case .cleared: return "History cleared"
        default: return "Clear agent history"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.clearPhase {
        case .idle:
            EmptyView()
        case .previewing:
            HStack(spacing: Spacing.sm) {
                ProgressView().controlSize(.small)
                Text("Counting what would be deleted…")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
            }
        case let .confirming(_, preview):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                if let counts = preview.wouldDelete {
                    countRow("Runs", counts.agentRuns)
                    countRow("Tool events", counts.agentToolEvents)
                    countRow("Turn composition", counts.turnComposition)
                    countRow("Daily rollups", counts.agentDaily)
                    countRow("Daily tool rollups", counts.agentDailyTools)
                }
                Divider()
                countRow("Total", preview.total)
                if preview.total == 0 {
                    Text("Nothing to delete.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                } else {
                    Text("This cannot be undone. Runs still in progress are kept.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
        case .clearing:
            HStack(spacing: Spacing.sm) {
                ProgressView().controlSize(.small)
                Text("Deleting…")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
            }
        case let .cleared(result):
            Text(AgentHistoryMessages.clearSuccess(result))
                .font(Typography.body)
                .foregroundStyle(theme.current.text)
        case let .failed(message):
            Text(message)
                .font(Typography.body)
                .foregroundStyle(theme.current.danger)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func countRow(_ label: String, _ value: Int) -> some View {
        HStack {
            Text(label).font(Typography.body).foregroundStyle(theme.current.text)
            Spacer()
            Text("\(value)").font(Typography.body).foregroundStyle(theme.current.textMuted).monospacedDigit()
        }
    }

    private func close() {
        model.cancelClear()
        dismiss()
    }
}
