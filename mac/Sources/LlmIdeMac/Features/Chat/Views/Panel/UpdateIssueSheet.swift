import SwiftUI

/// Sheet for updating an issue
struct UpdateIssueSheet: View {
    struct Args {
        var iid: Int
        var title: String?
        var body: String?
        var state: String?
        var labels: [String]?
    }

    enum ConfirmResult {
        case success(Int)
        case failure(String)
    }

    /// The open/close transition for a sheet `state` (GitLab's vocabulary —
    /// the picker's tags — plus the GitHub and verb spellings an agent may
    /// send). nil = leave the state alone.
    static func stateChange(for state: String?) -> RepoIssuePayload.StateChange? {
        switch state?.lowercased() {
        case "closed", "close": return .close
        case "opened", "open", "reopened", "reopen": return .reopen
        default: return nil
        }
    }

    let initialArgs: Args
    let issueTitle: String?
    let projectId: String
    let providerKind: RepoBackendKind
    let isAllowed: Bool
    let onConfirm: (Args) async -> ConfirmResult

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore
    @State private var title: String
    @State private var bodyText: String
    @State private var selectedState: String
    @State private var labelsText: String
    @State private var isRunning = false
    @State private var errorMessage: String?

    init(initialArgs: Args, issueTitle: String?, projectId: String, providerKind: RepoBackendKind, isAllowed: Bool, onConfirm: @escaping (Args) async -> ConfirmResult) {
        self.initialArgs = initialArgs
        self.issueTitle = issueTitle
        self.projectId = projectId
        self.providerKind = providerKind
        self.isAllowed = isAllowed
        self.onConfirm = onConfirm
        self._title = State(initialValue: initialArgs.title ?? "")
        self._bodyText = State(initialValue: initialArgs.body ?? "")
        self._selectedState = State(initialValue: initialArgs.state ?? "opened")
        self._labelsText = State(initialValue: (initialArgs.labels ?? []).joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Title")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextField("Issue title", text: $title)
                        .textFieldStyle(.roundedBorder)
                        .disabled(!isAllowed || isRunning)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("State")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Picker("State", selection: $selectedState) {
                        Text("Opened").tag("opened")
                        Text("Closed").tag("closed")
                    }
                    .pickerStyle(.segmented)
                    .disabled(!isAllowed || isRunning)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Labels")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextField("bug, enhancement, priority (comma-separated)", text: $labelsText)
                        .textFieldStyle(.roundedBorder)
                        .disabled(!isAllowed || isRunning)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Description")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextEditor(text: $bodyText)
                        .font(.system(size: 13))
                        .frame(height: 120)
                        .background(Color.secondary.opacity(0.05))
                        .cornerRadius(6)
                        .disabled(!isAllowed || isRunning)
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.current.danger)
                }

                Spacer()
                HStack(spacing: 12) {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)
                        .disabled(isRunning)

                    Button("Update Issue") { Task { await submit() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!isAllowed || isRunning || title.isEmpty)

                    if isRunning { ProgressView().scaleEffect(0.8) }
                }
            }
            .padding(20)
            .navigationTitle("Update Issue #\(initialArgs.iid)")
        }
        .frame(width: 500, height: 500)
    }

    private func submit() async {
        isRunning = true
        defer { isRunning = false }
        errorMessage = nil

        let labels = labelsText.isEmpty ? [] : labelsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }

        // Only a state the agent asked for, or one the user picked, is a
        // change: the picker DEFAULTS to "opened" when the agent named none,
        // and sending that would reopen a closed issue whose title was edited.
        let stateTouched = initialArgs.state != nil
            || selectedState != (initialArgs.state ?? "opened")
        // An emptied field clears the labels the issue came in with; an
        // untouched empty field leaves them alone.
        let clearedLabels = initialArgs.labels?.isEmpty == false ? [String]() : nil
        let args = Args(
            iid: initialArgs.iid,
            title: title.isEmpty ? nil : title,
            body: bodyText.isEmpty ? nil : bodyText,
            state: stateTouched ? selectedState : nil,
            labels: labels.isEmpty ? clearedLabels : labels
        )

        let result = await onConfirm(args)
        switch result {
        case .success: dismiss()
        case .failure(let message): errorMessage = message
        }
    }
}
