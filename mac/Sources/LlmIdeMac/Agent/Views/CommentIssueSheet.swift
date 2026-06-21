import SwiftUI

/// Editable confirmation sheet for the comment-issue write tool. Mirrors
/// `CreateIssueSheet`: the owner provides initial values and a confirm
/// callback; the sheet itself never calls any issue-tracker API, so it works
/// for either GitLab or GitHub.
struct CommentIssueSheet: View {
    @Environment(\.dismiss) private var dismiss

    enum ConfirmResult {
        case success(Int)            // note id on success
        case failure(String)
    }

    let projectName: String
    let projectURL: String
    /// Provider display name ("GitLab" / "GitHub") for the settings hint.
    let provider: String
    /// Display title for the issue (from recentIssues if known) — read-only.
    let issueTitle: String?
    let iid: Int
    let onConfirm: (Args) async -> ConfirmResult

    @State private var commentBody: String
    @State private var submitting: Bool = false
    @State private var errorMessage: String?

    struct Args {
        var iid: Int
        var body: String
    }

    init(initialArgs args: PendingTool.CommentIssueArgs,
         projectName: String,
         projectURL: String,
         provider: String,
         issueTitle: String?,
         onConfirm: @escaping (Args) async -> ConfirmResult) {
        self.projectName = projectName
        self.projectURL = projectURL
        self.provider = provider
        self.issueTitle = issueTitle
        self.iid = args.iid
        self.onConfirm = onConfirm
        _commentBody = State(initialValue: args.body)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Comment on issue").font(.title3.bold())
            Divider()

            VStack(alignment: .leading, spacing: 12) {
                field(label: "Issue") {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("#\(iid)\(issueTitle.map { " — \($0)" } ?? "")")
                            .font(.system(size: 12, weight: .medium))
                        Text("Read-only — cancel and re-ask if this isn't the right issue.")
                            .font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                }
                field(label: "Comment") {
                    TextEditor(text: $commentBody)
                        .font(.system(size: 12, design: .monospaced))
                        .frame(minHeight: 160, maxHeight: 320)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
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
                Button("Post comment") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || commentBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
        let args = Args(
            iid: iid,
            body: commentBody.trimmingCharacters(in: .whitespacesAndNewlines)
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
