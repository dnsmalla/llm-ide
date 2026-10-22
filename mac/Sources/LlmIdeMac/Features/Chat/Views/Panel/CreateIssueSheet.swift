import SwiftUI

/// Editable confirmation sheet for the create-issue write tool. The owner
/// provides the initial values + the "create" callback. The sheet itself
/// never calls any issue-tracker API — it just collects edits and reports
/// them back, so it works for either GitLab or GitHub (the owner picks the
/// backend) and stays reusable in tests.
struct CreateIssueSheet: View {
    @Environment(\.dismiss) private var dismiss

    /// Lightweight result type: issue number on success, human-readable
    /// error message on failure. Using a bespoke enum avoids the
    /// `Swift.Result` constraint that the failure type must conform to `Error`.
    enum ConfirmResult {
        case success(Int)
        case failure(String)
    }

    let projectName: String
    let projectURL: String
    /// Provider display name ("GitLab" / "GitHub") for the settings hint.
    let provider: String
    /// Whether the allow-list permits Create issue for the resolved
    /// provider. When false, submission is disabled and the tooltip
    /// points at the Settings toggle instead of describing the shortcut.
    let isAllowed: Bool
    let onConfirm: (Args) async -> ConfirmResult   // returns issue number on success

    @State private var title: String
    @State private var description: String
    @State private var labelsText: String          // comma-separated for v1
    @State private var assignee: String
    @State private var submitting: Bool = false
    @State private var errorMessage: String?

    struct Args {
        var title: String
        var description: String
        var labels: [String]
        var assignee: String?
    }

    init(initialArgs args: PendingTool.CreateIssueArgs,
         projectName: String,
         projectURL: String,
         provider: String,
         isAllowed: Bool = true,
         onConfirm: @escaping (Args) async -> ConfirmResult) {
        self.projectName = projectName
        self.projectURL = projectURL
        self.provider = provider
        self.isAllowed = isAllowed
        self.onConfirm = onConfirm
        _title = State(initialValue: args.title)
        _description = State(initialValue: args.description)
        _labelsText = State(initialValue: (args.labels ?? []).joined(separator: ", "))
        _assignee = State(initialValue: args.assignee ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Create issue").font(.title3.bold())
            Divider()

            VStack(alignment: .leading, spacing: 12) {
                field(label: "Title") {
                    TextField("", text: $title)
                        .textFieldStyle(.roundedBorder)
                }
                field(label: "Description") {
                    TextEditor(text: $description)
                        .font(.system(size: 12, design: .monospaced))
                        .frame(minHeight: 160, maxHeight: 320)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
                }
                field(label: "Labels") {
                    TextField("comma, separated", text: $labelsText)
                        .textFieldStyle(.roundedBorder)
                }
                field(label: "Assignee") {
                    TextField("@username (optional)", text: $assignee)
                        .textFieldStyle(.roundedBorder)
                }
                field(label: "Project") {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(projectName).font(.system(size: 12, weight: .medium))
                        Text(projectURL).font(.system(size: 11)).foregroundStyle(.secondary)
                        Text("Change in Settings → \(provider)")
                            .font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                }
            }

            if let err = errorMessage {
                Text(err)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(submitting)
                Button("Create issue") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || title.trimmingCharacters(in: .whitespaces).isEmpty || !isAllowed)
                    .help(isAllowed
                          ? ""
                          : "Enable Create issue in Settings → \(provider) → Automation & Actions")
            }
        }
        .padding(20)
        .frame(minWidth: 520)
    }

    @ViewBuilder
    private func field<Content: View>(label: String, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 80, alignment: .trailing)
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func submit() {
        let trimmedLabels = labelsText.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let trimmedAssignee = assignee
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
        let args = Args(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description,
            labels: trimmedLabels,
            assignee: trimmedAssignee.isEmpty ? nil : trimmedAssignee
        )
        Task {
            submitting = true
            defer { submitting = false }
            errorMessage = nil
            let outcome = await onConfirm(args)
            switch outcome {
            case .success:
                dismiss()
            case .failure(let msg):
                errorMessage = msg
            }
        }
    }
}
