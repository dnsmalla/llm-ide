import SwiftUI

/// Form editor for an issue's scheduling overlay (gantt parity for GitHub).
/// GitHub issues carry no start/due/estimate/dependency fields, so this sheet
/// writes them to our backend (LlmIdeAPIClient.upsertIssueSchedule). The gantt
/// then draws a real bar from start → due. Dates are optional — a disabled
/// toggle clears that field on save.
struct IssueScheduleEditorSheet: View {
    @EnvironmentObject var theme: ThemeStore

    let api: LlmIdeAPIClient
    let provider: String            // "github"
    let repo: String                // "owner/name"
    let issueNumber: Int
    let issueTitle: String
    let existing: LlmIdeAPIClient.IssueSchedule?
    var onSaved: (LlmIdeAPIClient.IssueSchedule?) -> Void
    var onDismiss: () -> Void

    @State private var hasStart: Bool
    @State private var start: Date
    @State private var hasDue: Bool
    @State private var due: Date
    @State private var estimate: Double
    @State private var dependsOnText: String
    @State private var saving = false
    @State private var error: String?

    init(api: LlmIdeAPIClient, provider: String, repo: String, issueNumber: Int,
         issueTitle: String, existing: LlmIdeAPIClient.IssueSchedule?,
         onSaved: @escaping (LlmIdeAPIClient.IssueSchedule?) -> Void,
         onDismiss: @escaping () -> Void) {
        self.api = api; self.provider = provider; self.repo = repo
        self.issueNumber = issueNumber; self.issueTitle = issueTitle
        self.existing = existing; self.onSaved = onSaved; self.onDismiss = onDismiss

        let startDate = existing?.startDate.flatMap(AppDateFormatter.parseDateOnly)
        let dueDate = existing?.dueDate.flatMap(AppDateFormatter.parseDateOnly)
        _hasStart = State(initialValue: startDate != nil)
        _start = State(initialValue: startDate ?? Date())
        _hasDue = State(initialValue: dueDate != nil)
        _due = State(initialValue: dueDate ?? Date())
        _estimate = State(initialValue: existing?.estimateDays ?? 0)
        _dependsOnText = State(initialValue: (existing?.dependsOn ?? []).map(String.init).joined(separator: ", "))
    }

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            header(t)
            Divider().background(t.border)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    dateRow(t, label: "Start date", isOn: $hasStart, date: $start)
                    dateRow(t, label: "Due date", isOn: $hasDue, date: $due)
                    estimateRow(t)
                    dependsOnRow(t)
                    if let e = error {
                        Text(e).font(Typography.caption).foregroundStyle(t.danger)
                    }
                }
                .padding(Spacing.lg)
            }
            Divider().background(t.border)
            footer(t)
        }
        .frame(width: 460, height: 420)
        .background(t.body)
    }

    private func header(_ t: Theme) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Schedule").font(.system(size: 13, weight: .semibold)).foregroundStyle(t.text)
                Text("#\(issueNumber) · \(issueTitle)")
                    .font(Typography.caption).foregroundStyle(t.textMuted).lineLimit(1)
            }
            Spacer()
            Button { onDismiss() } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(t.textMuted)
            }
            .buttonStyle(.plain).help("Close")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(t.surface)
    }

    private func dateRow(_ t: Theme, label: String, isOn: Binding<Bool>, date: Binding<Date>) -> some View {
        HStack {
            Toggle(isOn: isOn) {
                Text(label).font(Typography.bodyStrong).foregroundStyle(t.text)
            }
            .toggleStyle(.checkbox)
            Spacer()
            DatePicker("", selection: date, displayedComponents: .date)
                .labelsHidden()
                .disabled(!isOn.wrappedValue)
                .opacity(isOn.wrappedValue ? 1 : 0.4)
        }
    }

    private func estimateRow(_ t: Theme) -> some View {
        HStack {
            Text("Estimate").font(Typography.bodyStrong).foregroundStyle(t.text)
            Spacer()
            Stepper(value: $estimate, in: 0...365, step: 0.5) {
                Text(estimate > 0 ? "\(estimate.clean) days" : "none")
                    .font(Typography.body).foregroundStyle(estimate > 0 ? t.text : t.textMuted)
            }
            .frame(width: 200)
        }
    }

    private func dependsOnRow(_ t: Theme) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Depends on").font(Typography.bodyStrong).foregroundStyle(t.text)
            TextField("issue numbers, comma-separated (e.g. 12, 34)", text: $dependsOnText)
                .textFieldStyle(.roundedBorder).font(Typography.body)
            Text("Blocking issues — drawn as dependencies in a later update.")
                .font(Typography.caption).foregroundStyle(t.textMuted)
        }
    }

    private func footer(_ t: Theme) -> some View {
        HStack {
            if existing != nil {
                Button(role: .destructive) { Task { await clear() } } label: {
                    Text("Clear schedule").font(Typography.body)
                }
                .buttonStyle(.plain).foregroundStyle(t.danger).disabled(saving)
            }
            Spacer()
            Button("Cancel") { onDismiss() }.disabled(saving)
            Button { Task { await save() } } label: {
                if saving { ProgressView().controlSize(.small) } else { Text("Save").bold() }
            }
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(saving)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(t.surface)
    }

    // Parse the comma-separated depends-on field into positive ints (silently
    // dropping junk — the backend validates again and rejects anything bad).
    private var parsedDependsOn: [Int] {
        dependsOnText
            .split(whereSeparator: { $0 == "," || $0 == " " })
            .compactMap { Int($0) }
            .filter { $0 > 0 }
    }

    private func save() async {
        saving = true; error = nil
        defer { saving = false }
        do {
            let saved = try await api.upsertIssueSchedule(
                provider: provider, repo: repo, issueNumber: issueNumber,
                startDate: hasStart ? AppDateFormatter.dateOnly(start) : nil,
                dueDate: hasDue ? AppDateFormatter.dateOnly(due) : nil,
                estimateDays: estimate > 0 ? estimate : nil,
                dependsOn: parsedDependsOn,
            )
            onSaved(saved)
            onDismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func clear() async {
        saving = true; error = nil
        defer { saving = false }
        do {
            _ = try await api.deleteIssueSchedule(provider: provider, repo: repo, issueNumber: issueNumber)
            onSaved(nil)
            onDismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private extension Double {
    /// Drop a trailing ".0" so "3.0 days" shows as "3 days" but "3.5" stays.
    var clean: String {
        truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(self))
            : String(format: "%.1f", self)
    }
}
