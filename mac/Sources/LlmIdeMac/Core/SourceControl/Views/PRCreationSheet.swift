import SwiftUI

/// Editable confirmation sheet for the create-pr write tool.
struct PRCreationSheet: View {
    @Environment(\.dismiss) private var dismiss

    enum ConfirmResult: Equatable {
        case success(iid: Int, webUrl: String)
        case failure(String)
    }

    let initialArgs: CreatePRArgs
    let projectName: String
    let projectURL: String
    let provider: String // "GitLab" or "GitHub"
    let isAllowed: Bool
    let onConfirm: (Args) async -> ConfirmResult

    @State private var title: String
    @State private var description: String
    @State private var sourceBranch: String
    @State private var targetBranch: String
    @State private var labels: String
    @State private var assignee: String
    @State private var isCreating: Bool = false
    @State private var confirmResult: ConfirmResult?

    struct CreatePRArgs {
        let title: String
        let description: String
        let sourceBranch: String
        let targetBranch: String
        let labels: [String]?
        let assignee: String?
    }

    struct Args {
        let title: String
        let description: String
        let sourceBranch: String
        let targetBranch: String
        let labels: [String]?
        let assignee: String?
    }

    init(initialArgs: CreatePRArgs, projectName: String, projectURL: String,
         provider: String, isAllowed: Bool, onConfirm: @escaping (Args) async -> ConfirmResult) {
        self.initialArgs = initialArgs
        self.projectName = projectName
        self.projectURL = projectURL
        self.provider = provider
        self.isAllowed = isAllowed
        self.onConfirm = onConfirm
        _title = State(initialValue: initialArgs.title)
        _description = State(initialValue: initialArgs.description)
        _sourceBranch = State(initialValue: initialArgs.sourceBranch)
        _targetBranch = State(initialValue: initialArgs.targetBranch)
        _labels = State(initialValue: initialArgs.labels?.joined(separator: ", ") ?? "")
        _assignee = State(initialValue: initialArgs.assignee ?? "")
    }

    var body: some View {
        VStack(spacing: 16) {
            Text("Create \(provider == "GitLab" ? "Merge Request" : "Pull Request")")
                .font(.system(size: 16, weight: .semibold))

            if !isAllowed {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("PR creation is blocked by allow-list")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Title")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)

                TextField("PR title", text: $title)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isCreating)

                Text("\(projectName)")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Description")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)

                TextEditor(text: $description)
                    .frame(height: 100)
                    .border(Color.secondary.opacity(0.2))
                    .disabled(isCreating)
            }

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Source Branch")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)

                    TextField("e.g., feature/new-auth", text: $sourceBranch)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isCreating)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Target Branch")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)

                    TextField("e.g., main", text: $targetBranch)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isCreating)
                }
            }

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Labels (comma-separated)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)

                    TextField("bug, enhancement", text: $labels)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isCreating)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Assignee (optional)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)

                    TextField("username", text: $assignee)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isCreating)
                }
            }

            if let result = confirmResult {
                switch result {
                case .success(let iid, _):
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text("\(provider == "GitLab" ? "MR" : "PR") #\(iid) created successfully")
                            .font(.system(size: 12))
                    }
                case .failure(let error):
                    HStack(spacing: 8) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.red)
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(.red)
                    }
                }
            }

            HStack(spacing: 12) {
                Button("Cancel") {
                    dismiss()
                }
                .disabled(isCreating)

                Button("Create \(provider == "GitLab" ? "Merge Request" : "Pull Request")") {
                    isCreating = true
                    let args = Args(
                        title: title,
                        description: description,
                        sourceBranch: sourceBranch,
                        targetBranch: targetBranch,
                        labels: labels.isEmpty ? nil : labels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) },
                        assignee: assignee.isEmpty ? nil : assignee
                    )
                    Task {
                        let result = await onConfirm(args)
                        await MainActor.run {
                            self.confirmResult = result
                            self.isCreating = false
                            if case .success = result {
                                dismiss()
                            }
                        }
                    }
                }
                .disabled(title.isEmpty || sourceBranch.isEmpty || targetBranch.isEmpty || isCreating || !isAllowed)
                .buttonStyle(.borderedProminent)
            }

            Spacer()
        }
        .padding(20)
        .frame(width: 600, height: 600)
    }
}
