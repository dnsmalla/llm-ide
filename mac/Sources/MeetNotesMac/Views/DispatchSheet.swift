import SwiftUI

/// Sheet that previews and submits a plan dispatch to the review queue.
/// Workflow:
///   1. On open, /kb/dispatch with target=preview (server-side, no
///      external API call) → returns the exact ticket each task would
///      become.
///   2. User picks a provider (GitHub / Backlog / Linear), fills in
///      credentials, multi-selects tasks.
///   3. Submit → /kb/review/submit (kind=dispatch).  Server runs
///      guardrails; user approves in ReviewView before tickets fire.
struct DispatchSheet: View {
    let api: MeetNotesAPIClient
    let plan: Plan
    let onSubmitted: (MeetNotesAPIClient.ReviewItem) -> Void
    let onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var target: MeetNotesAPIClient.DispatchTarget = .github
    @State private var loadingPreview = true
    @State private var previewError: String?
    @State private var preview: MeetNotesAPIClient.DispatchPreviewResponse?
    @State private var selected: Set<String> = []
    @State private var configFields: [String: String] = [:]
    @State private var submitting = false
    @State private var submitError: String?
    @State private var availableSecrets: Set<String> = []

    private static let fieldDefs: [MeetNotesAPIClient.DispatchTarget: [(key: String, label: String, secret: Bool)]] = [
        .github:  [("repo", "Repo (owner/name)", false), ("token", "GitHub token (PAT)", true), ("labels", "Labels (comma-separated)", false)],
        .backlog: [("space", "Backlog space (subdomain.backlog.com)", false), ("projectId", "Project ID", false), ("apiKey", "API key", true), ("issueTypeId", "Issue type ID", false), ("priorityId", "Priority ID (default 3)", false)],
        .linear:  [("teamId", "Team ID", false), ("apiKey", "API key", true), ("projectId", "Project ID (optional)", false)],
    ]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(theme.current.border)
            content
            Divider().background(theme.current.border)
            footer
        }
        .frame(minWidth: 720, minHeight: 540)
        .background(theme.current.body)
        .task { await loadPreview() }
        .task { await loadSecrets() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                SectionLabel("Dispatch tasks", size: 12)
                Text(plan.title)
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                    .lineLimit(2)
                Text("\(plan.tasks.count) total tasks · \(selected.count) selected")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer()
            Button("Close", action: onDismiss)
                .keyboardShortcut(.cancelAction)
        }
        .padding(Spacing.lg)
    }

    @ViewBuilder
    private var content: some View {
        HSplitView {
            previewPane
                .frame(minWidth: 300, idealWidth: 380)
            configPane
                .frame(minWidth: 320, idealWidth: 380, maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var previewPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack {
                    SectionLabel("Tasks", size: 12)
                    Spacer()
                    Button(selected.count == previewItems.count ? "Clear all" : "Select all") {
                        toggleSelectAll()
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                }
                if loadingPreview {
                    HStack { ProgressView().controlSize(.small); Text("Loading preview…") }
                        .foregroundStyle(theme.current.textMuted)
                        .padding(.vertical, Spacing.md)
                } else if let err = previewError {
                    Text(err).font(Typography.caption).foregroundStyle(theme.current.danger)
                } else if previewItems.isEmpty {
                    Text("No tasks to dispatch.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                } else {
                    ForEach(previewItems) { item in
                        rowView(item)
                    }
                }
            }
            .padding(Spacing.md)
        }
    }

    private func rowView(_ item: MeetNotesAPIClient.DispatchPreviewItem) -> some View {
        let isSelected = selected.contains(item.taskId)
        return Button {
            if isSelected { selected.remove(item.taskId) } else { selected.insert(item.taskId) }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(isSelected ? theme.current.accent : theme.current.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(theme.current.text)
                        .lineLimit(2)
                    Text(item.body.split(separator: "\n").first.map(String.init) ?? "")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(2)
                }
                Spacer()
            }
            .padding(8)
            .background(isSelected ? theme.current.accent.opacity(0.08) : Color.clear)
            .cornerRadius(4)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var configPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                HStack(spacing: Spacing.md) {
                    Text("Provider")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 70, alignment: .leading)
                    Picker("", selection: $target) {
                        ForEach(MeetNotesAPIClient.DispatchTarget.allCases) { t in
                            Text(providerLabel(t)).tag(t)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                }

                ForEach(Self.fieldDefs[target] ?? [], id: \.key) { def in
                    fieldRow(def)
                }

                if let err = submitError {
                    Text(err).font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                hint(forTarget: target)
            }
            .padding(Spacing.lg)
        }
    }

    private func fieldRow(_ def: (key: String, label: String, secret: Bool)) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(def.label)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            if def.secret {
                SecureField("", text: bindingFor(def.key))
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField("", text: bindingFor(def.key))
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
            }
        }
    }

    @ViewBuilder
    private func hint(forTarget t: MeetNotesAPIClient.DispatchTarget) -> some View {
        let copy: String = {
            switch t {
            case .github:  return "Token needs `repo` scope. Stays in the review payload only — never persisted server-side."
            case .backlog: return "Space is the hostname (e.g. yourteam.backlog.com). Issue type ID is the integer Backlog assigns to bug / task / feature."
            case .linear:  return "Team ID is Linear's UUID-style team identifier (Settings → API in Linear web)."
            }
        }()
        Text(copy)
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel", action: onDismiss)
                .keyboardShortcut(.cancelAction)
            Button(submitting ? "Submitting…" : "Submit \(selected.count) for review") {
                Task { await submit() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(submitting || selected.isEmpty || !credsComplete)
        }
        .padding(Spacing.lg)
    }

    // MARK: - State helpers

    private var previewItems: [MeetNotesAPIClient.DispatchPreviewItem] {
        preview?.results ?? []
    }

    private var credsComplete: Bool {
        let required = (Self.fieldDefs[target] ?? []).filter { $0.label.contains("optional") == false && $0.key != "labels" && $0.key != "priorityId" && $0.key != "projectId" }
        return required.allSatisfy { !(configFields[$0.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func bindingFor(_ key: String) -> Binding<String> {
        Binding(
            get: { configFields[key] ?? "" },
            set: { configFields[key] = $0 },
        )
    }

    private func providerLabel(_ t: MeetNotesAPIClient.DispatchTarget) -> String {
        let hasSecret: Bool = {
            switch t {
            case .github:  return availableSecrets.contains("github.token")
            case .backlog: return availableSecrets.contains("backlog.apiKey")
            case .linear:  return availableSecrets.contains("linear.apiKey")
            }
        }()
        return hasSecret ? "\(t.displayName) ✓" : t.displayName
    }

    private func toggleSelectAll() {
        if selected.count == previewItems.count {
            selected.removeAll()
        } else {
            selected = Set(previewItems.map(\.taskId))
        }
    }

    // MARK: - Network

    private func loadPreview() async {
        loadingPreview = true
        previewError = nil
        defer { loadingPreview = false }
        do {
            let p = try await api.previewDispatch(planId: plan.id, taskIds: nil)
            preview = p
            // Default-select all tasks.
            selected = Set(p.results.map(\.taskId))
        } catch {
            previewError = error.localizedDescription
        }
    }

    private func loadSecrets() async {
        do {
            let r = try await api.listSecretKeys()
            availableSecrets = Set(r.secrets.map(\.key))
        } catch {
            // Non-fatal; we just don't show ✓ marks.
        }
    }

    private func submit() async {
        guard !selected.isEmpty else { return }
        submitting = true
        submitError = nil
        defer { submitting = false }
        let items = previewItems.filter { selected.contains($0.taskId) }
        // Compact the config dict to just the fields the user filled in.
        let cfg: [String: String] = configFields.reduce(into: [:]) { acc, kv in
            let v = kv.value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !v.isEmpty { acc[kv.key] = v }
        }
        do {
            let item = try await api.submitDispatchForReview(
                planId: plan.id,
                planTitle: plan.title,
                target: target,
                taskIds: Array(selected),
                items: items,
                config: cfg,
            )
            onSubmitted(item)
        } catch {
            submitError = error.localizedDescription
        }
    }
}
