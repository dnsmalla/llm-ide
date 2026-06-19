import SwiftUI

/// Plan tab.  Two-pane layout: list of saved plans on the left, the
/// selected plan's milestone tree on the right.  Mirrors the React
/// PlanView's shape — milestone groups, task cards with risk-colored
/// borders, owner / due / estimate chips, expandable code refs.
struct PlanView: View {
    @EnvironmentObject var theme: ThemeStore
    @StateObject private var viewModel: PlanListViewModel
    /// Per-plan-task useful-rate.  nil entries (no feedback yet) are
    /// just absent from the dictionary; rendering checks before
    /// drawing the chip.  Refreshed on view appear and after a
    /// plan reload.
    @State private var feedbackByTask: [String: LlmIdeAPIClient.AgentFeedbackByTaskItem] = [:]
    /// Latest outcome state per task — drives the per-task chip
    /// ("open · in_progress · done").  Populated lazily after refresh
    /// (or when the user opens a plan that has dispatched tasks).
    @State private var outcomeByTask: [String: LlmIdeAPIClient.Outcome] = [:]
    @State private var outcomesRefreshing: Bool = false
    @State private var outcomesError: String?
    /// Per-task codegen sheet — non-nil triggers the .sheet binding.
    @State private var codegenTask: PlanTask?
    /// Plan-level dispatch sheet.
    @State private var dispatching = false
    /// Last-submitted review item id, so the success toast can deep
    /// link to it.  Cleared when the user dismisses the toast.
    @State private var lastSubmittedItemId: String?
    @State private var lastSubmittedKind: String?
    /// Callback the parent (ContentView) wires up so a successful
    /// submit can switch to the Review tab without an extra click.
    let onJumpToReview: (() -> Void)?
    /// Synced UI prefs — language flows from /auth/me/prefs so codegen
    /// output matches the user's chosen LLM language.
    @State private var prefLanguage: String = "en"
    @State private var loadTask: Task<Void, Never>?

    private let api: LlmIdeAPIClient

    init(api: LlmIdeAPIClient, onJumpToReview: (() -> Void)? = nil) {
        self.api = api
        self.onJumpToReview = onJumpToReview
        _viewModel = StateObject(wrappedValue: PlanListViewModel(api: api))
    }

    var body: some View {
        // Fixed-width list column — HSplitView overrides a child's width
        // frame, so pin it outside the split to keep it minimal.
        HStack(spacing: 0) {
            list
                .frame(width: 280)
            Divider()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.current.body)
        .task {
            await viewModel.refresh()
            async let fb: Void = loadFeedbackByTask()
            async let lang: Void = loadLanguage()
            _ = await (fb, lang)
        }
        // Re-fetch outcome chips whenever the selected plan changes.
        // Cheap because we skip tasks that were never dispatched.
        .onChange(of: viewModel.selected?.id) { _, _ in
            loadTask?.cancel()
            loadTask = Task {
                async let fb: Void = loadFeedbackByTask()
                async let lang: Void = loadLanguage()
                _ = await (fb, lang)
            }
            outcomeByTask.removeAll()
            Task { await loadOutcomesEagerly() }
        }
        .onDisappear {
            loadTask?.cancel()
        }
        .sheet(item: $codegenTask) { task in
            if let plan = viewModel.selected {
                CodegenSheet(
                    api: api,
                    plan: plan,
                    task: task,
                    language: prefLanguage,
                    onSubmitted: { item in
                        lastSubmittedItemId = item.id
                        lastSubmittedKind = item.kind
                        codegenTask = nil
                        onJumpToReview?()
                    },
                    onDismiss: { codegenTask = nil },
                )
                .environmentObject(theme)
            }
        }
        .sheet(isPresented: $dispatching) {
            if let plan = viewModel.selected {
                DispatchSheet(
                    api: api,
                    plan: plan,
                    onSubmitted: { item in
                        lastSubmittedItemId = item.id
                        lastSubmittedKind = item.kind
                        dispatching = false
                        onJumpToReview?()
                    },
                    onDismiss: { dispatching = false },
                )
                .environmentObject(theme)
            }
        }
    }

    @ViewBuilder
    private var list: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Plans").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
                Button {
                    Task { await viewModel.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.current.textMuted)
                .help("Refresh")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(theme.current.surface)

            if viewModel.loadingList && viewModel.summaries.isEmpty {
                ProgressView().padding(20)
            } else if viewModel.summaries.isEmpty {
                Text("No plans yet.\nGenerate a plan from a meeting in the web extension or via the API.")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.textMuted)
                    .multilineTextAlignment(.leading)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                List(selection: Binding(
                    get: { viewModel.selected?.id },
                    set: { newID in
                        if let id = newID {
                            Task { await viewModel.open(id: id) }
                        } else {
                            viewModel.clear()
                        }
                    }
                )) {
                    ForEach(viewModel.summaries) { plan in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(plan.title)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(theme.current.text)
                                .lineLimit(2)
                            Text("\(plan.taskCount) tasks · \(formatTimestamp(plan.updatedAt))")
                                .font(.system(size: 10))
                                .foregroundStyle(theme.current.textMuted)
                        }
                        .tag(plan.id)
                        .padding(.vertical, 2)
                    }
                }
                .listStyle(.sidebar)
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if viewModel.loadingDetail {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let plan = viewModel.selected {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(plan.title)
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundStyle(theme.current.text)
                                if let goal = plan.goal, !goal.isEmpty {
                                    Text(goal)
                                        .font(.system(size: 13))
                                        .foregroundStyle(theme.current.textMuted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer()
                            // Outcome refresh — polls every dispatched
                            // task for its current external state.
                            // Visible only if at least one task has been
                            // dispatched (otherwise there's nothing to
                            // poll).
                            if hasDispatchedTask(plan) {
                                Button {
                                    Task { await refreshOutcomes(plan: plan) }
                                } label: {
                                    Label(outcomesRefreshing ? "Polling…" : "Refresh status",
                                          systemImage: outcomesRefreshing ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .disabled(outcomesRefreshing)
                                .help("Poll the external tracker for the current state of every dispatched task.")
                            }
                            // Production-control toolbar — review-gated.
                            // "Dispatch tasks" opens the provider picker
                            // + multi-select + credential capture.  Items
                            // land in ReviewView, never fire externally
                            // without explicit approval.
                            Button {
                                dispatching = true
                            } label: {
                                Label("Dispatch tasks…", systemImage: "paperplane.fill")
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(plan.tasks.isEmpty)
                            .help("Preview each task as a ticket, choose provider, and submit to the review queue.")
                        }
                        if let err = outcomesError {
                            Text(err)
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.danger)
                                .padding(.top, 2)
                        }
                        riskCounters(for: plan.tasks)
                            .padding(.top, 4)
                    }
                    if let kind = lastSubmittedKind {
                        submittedToast(kind: kind)
                    }
                    Divider().background(theme.current.border)

                    ForEach(milestoneGroups(plan.tasks), id: \.title) { group in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(group.title.uppercased())
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(theme.current.textMuted)
                                .padding(.horizontal, 2)
                            ForEach(group.tasks) { task in
                                taskCard(task: task)
                            }
                        }
                    }
                }
                .padding(20)
            }
        } else {
            VStack {
                Spacer()
                Text("Select a plan from the list.")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func taskCard(task: PlanTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(task.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.current.text)
                Spacer()
                KindChip.status(task.status)
            }
            if let desc = task.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                if let owner = task.owner, !owner.isEmpty {
                    KindChip(label: "@\(owner)", palette: .neutral)
                }
                if let due = task.due { KindChip(label: "due \(due)", palette: .info) }
                if let est = task.estimateDays {
                    KindChip(label: "\(formatEstimate(est))d", palette: .neutral)
                }
                if let risk = task.risk { KindChip.risk(risk) }
                if let fb = feedbackByTask[task.id], fb.total > 0 {
                    agentFeedbackChip(fb)
                }
                if let outcome = outcomeByTask[task.id] {
                    outcomeChip(outcome)
                }
            }
            if let reason = task.riskReason, !reason.isEmpty {
                Label(reason, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.accent4)
            }
            if !task.files.isEmpty {
                DisclosureGroup("Code refs (\(task.files.count))") {
                    ForEach(task.files) { ref in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ref.title)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(theme.current.text)
                            if let body = ref.bodyExcerpt {
                                Text(body)
                                    .font(.system(size: 10))
                                    .foregroundStyle(theme.current.textMuted)
                                    .lineLimit(2)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .font(.system(size: 11))
                .foregroundStyle(theme.current.accent2)
            }
            // Per-task control bar — code generation submits to the
            // review queue (kind=codegen-apply), never writes directly.
            HStack {
                Spacer()
                Button {
                    codegenTask = task
                } label: {
                    Label("Generate code", systemImage: "wand.and.stars")
                        .font(.system(size: 11))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Run the codegen agent on this task, preview the output, then submit to the review queue.")
            }
            .padding(.top, 4)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.current.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(borderColor(for: task), lineWidth: 2)
                .opacity(task.risk == nil ? 0 : 0.6)
        )
        .cornerRadius(6)
        .opacity(task.resolvedStatus == .done ? 0.55 : 1.0)
    }

    private func borderColor(for task: PlanTask) -> Color {
        switch task.resolvedRisk {
        case .high?: return theme.current.danger
        case .med?:  return theme.current.accent4
        case .low?:  return theme.current.accent3
        default:     return theme.current.border
        }
    }

    @ViewBuilder
    private func riskCounters(for tasks: [PlanTask]) -> some View {
        let counts = tasks.reduce(into: (high: 0, med: 0, low: 0)) { acc, t in
            switch t.resolvedRisk {
            case .high?: acc.high += 1
            case .med?:  acc.med += 1
            case .low?:  acc.low += 1
            default: break
            }
        }
        HStack(spacing: 6) {
            Text("\(tasks.count) tasks").font(.system(size: 11)).foregroundStyle(theme.current.textMuted)
            if counts.high > 0 { KindChip(label: "\(counts.high) high", palette: .danger) }
            if counts.med  > 0 { KindChip(label: "\(counts.med) med", palette: .warning) }
            if counts.low  > 0 { KindChip(label: "\(counts.low) low", palette: .success) }
        }
    }

    private struct Group {
        let title: String
        let tasks: [PlanTask]
    }

    private func milestoneGroups(_ tasks: [PlanTask]) -> [Group] {
        var ordered: [String] = []
        var bucket: [String: [PlanTask]] = [:]
        for t in tasks {
            let key = t.milestone ?? "(no milestone)"
            if bucket[key] == nil { ordered.append(key) }
            bucket[key, default: []].append(t)
        }
        return ordered.map { Group(title: $0, tasks: bucket[$0] ?? []) }
    }

    private func formatEstimate(_ d: Double) -> String {
        d.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(d))
            : String(format: "%.1f", d)
    }

    /// Per-task agent feedback chip — parity with the side panel.
    /// Color-coded by useful-rate: green ≥ 60%, amber 30–59%,
    /// red < 30%.  Tooltip exposes the full breakdown.
    @ViewBuilder
    private func agentFeedbackChip(_ stats: LlmIdeAPIClient.AgentFeedbackByTaskItem) -> some View {
        let pct = stats.usefulRate.map { Int(($0 * 100).rounded()) }
        let color: Color = {
            guard let p = pct else { return theme.current.textMuted }
            if p >= 60 { return theme.current.accent3 }    // success-ish
            if p >= 30 { return theme.current.accent4 }    // warning
            return theme.current.danger
        }()
        let label = pct.map { "agent: \($0)% useful (\(stats.total))" }
            ?? "agent: — (\(stats.total))"
        let tooltip = [
            "\(stats.byVerdict.useful) useful, \(stats.byVerdict.noise) noise, \(stats.byVerdict.later) later",
            stats.avgScoreUseful.map { "avg score (useful): \(String(format: "%.2f", $0))" },
            stats.avgScoreNoise.map  { "avg score (noise): \(String(format: "%.2f", $0))"  },
        ].compactMap { $0 }.joined(separator: " · ")
        Text(label)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.18))
            .foregroundStyle(color)
            .clipShape(Capsule())
            .help(tooltip)
    }

    /// True when at least one task has been dispatched (its meta has a
    /// `dispatched.url`).  Drives visibility of the "Refresh status"
    /// button — no point polling if nothing was ever dispatched.
    private func hasDispatchedTask(_ plan: Plan) -> Bool {
        for t in plan.tasks where wasDispatched(t) { return true }
        return false
    }

    /// `meta` is a per-row dict whose `dispatched` entry — when set —
    /// is a sub-object `{ provider, url, number, state, dispatchedAt }`.
    /// We treat any non-nil `dispatched.url` as proof of dispatch.
    private func wasDispatched(_ t: PlanTask) -> Bool {
        guard let dispatched = t.meta?["dispatched"]?.value as? [String: Any] else { return false }
        return dispatched["url"] != nil
    }

    /// Color + label for an outcome row.  Terminal states (done /
    /// closed) get the green palette; in-progress is amber; everything
    /// else is muted.
    @ViewBuilder
    private func outcomeChip(_ o: LlmIdeAPIClient.Outcome) -> some View {
        let palette: KindChip.Palette = {
            if o.isTerminal { return .success }
            switch o.state.lowercased() {
            case "in_progress", "in-progress", "open": return .warning
            default:                                    return .neutral
            }
        }()
        KindChip(label: "\(o.provider): \(o.state)", palette: palette)
            .help("Last observed: \(o.observedAt)")
    }

    /// Poll /kb/outcomes/refresh for every dispatched task in this plan.
    /// Server runs the provider-specific GETs (GitHub / Backlog / Linear)
    /// and persists changed rows.  We then re-read each task's latest
    /// row to refresh the chips.
    private func refreshOutcomes(plan: Plan) async {
        outcomesRefreshing = true
        outcomesError = nil
        defer { outcomesRefreshing = false }
        do {
            let summary = try await api.refreshOutcomes(taskIds: plan.tasks.map(\.id))
            // Best-effort: reload each task's latest outcome row.  We
            // serialize on purpose to be polite — the server already
            // hit four external APIs in parallel during refresh.
            for t in plan.tasks {
                let rows = try? await api.listOutcomesForTask(taskId: t.id)
                if let latest = rows?.first {
                    outcomeByTask[t.id] = latest
                }
            }
            if summary.pollErroredCount > 0 {
                outcomesError = "\(summary.pollErroredCount) of \(summary.pollCount) polls errored (missing credentials, rate-limit, or provider 4xx)."
            }
        } catch {
            outcomesError = error.localizedDescription
        }
    }

    /// Eager-load the latest outcome for every task in the currently
    /// selected plan so chips render without requiring a manual refresh.
    private func loadOutcomesEagerly() async {
        guard let plan = viewModel.selected else { return }
        var next: [String: LlmIdeAPIClient.Outcome] = [:]
        for t in plan.tasks where wasDispatched(t) {
            if let rows = try? await api.listOutcomesForTask(taskId: t.id),
               let latest = rows.first {
                next[t.id] = latest
            }
        }
        outcomeByTask = next
    }

    /// Post-submit toast that surfaces what just landed in the review
    /// queue.  Clickable area calls onJumpToReview if wired (the
    /// parent ContentView sets activeTab = .review).
    @ViewBuilder
    private func submittedToast(kind: String) -> some View {
        let label = kind == "dispatch" ? "Dispatch submitted to review" : "Code apply submitted to review"
        HStack(spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(theme.current.accent3)
            Text(label)
                .font(Typography.body)
                .foregroundStyle(theme.current.text)
            Spacer()
            if onJumpToReview != nil {
                Button("Open Review", action: { onJumpToReview?() })
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
            Button {
                lastSubmittedItemId = nil
                lastSubmittedKind = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
        }
        .padding(8)
        .background(theme.current.accent3.opacity(0.12))
        .cornerRadius(6)
    }

    /// Read the user's synced language pref so codegen output is in
    /// the right language.  Non-fatal — defaults to "en" on error.
    private func loadLanguage() async {
        do {
            let p = try await api.getUserPrefs()
            prefLanguage = p.language ?? "en"
        } catch {
            prefLanguage = "en"
        }
    }

    /// Load (or refresh) the per-task feedback summary.  Fire-and-
    /// forget — failures just leave the chip absent.
    private func loadFeedbackByTask() async {
        if let items = try? await api.getAgentFeedbackByTask() {
            var map: [String: LlmIdeAPIClient.AgentFeedbackByTaskItem] = [:]
            for it in items { map[it.planTaskId] = it }
            feedbackByTask = map
        }
    }

    private func formatTimestamp(_ s: String) -> String {
        // Server returns SQLite "2026-05-01 08:09:00" — show just the
        // date so the list stays compact.  Falls through to raw if the
        // shape is unexpected.
        s.split(separator: " ").first.map(String.init) ?? s
    }
}
