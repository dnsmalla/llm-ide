import SwiftUI

/// Editable confirmation sheet for the create-branch write tool.
struct BranchCreationSheet: View {
    @Environment(\.dismiss) private var dismiss

    enum ConfirmResult: Equatable {
        case success(String)
        case failure(String)
    }

    let initialArgs: CreateBranchArgs
    let currentBranch: String?
    let onConfirm: (Args) async -> ConfirmResult

    @State private var branchName: String
    @State private var startPoint: String
    @State private var isCreating: Bool = false
    @State private var confirmResult: ConfirmResult?

    struct CreateBranchArgs {
        let branch: String
        let startPoint: String?
    }

    struct Args {
        let branch: String
        let startPoint: String?
    }

    init(initialArgs: CreateBranchArgs, currentBranch: String?, onConfirm: @escaping (Args) async -> ConfirmResult) {
        self.initialArgs = initialArgs
        self.currentBranch = currentBranch
        self.onConfirm = onConfirm
        _branchName = State(initialValue: initialArgs.branch)
        _startPoint = State(initialValue: initialArgs.startPoint ?? "")
    }

    var body: some View {
        VStack(spacing: 16) {
            Text("Create Branch")
                .font(.system(size: 16, weight: .semibold))

            VStack(alignment: .leading, spacing: 8) {
                Text("Branch Name")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)

                TextField("e.g., feature/new-auth", text: $branchName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isCreating)

                if let current = currentBranch {
                    Text("Current branch: \(current)")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Start Point (optional)")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)

                TextField("e.g., main, HEAD~3", text: $startPoint)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isCreating)

                Text("Leave empty to create from current HEAD")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            if let result = confirmResult {
                switch result {
                case .success(let branch):
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text("Branch '\(branch)' created successfully")
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

                Button("Create Branch") {
                    isCreating = true
                    let args = Args(branch: branchName, startPoint: startPoint.isEmpty ? nil : startPoint)
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
                .disabled(branchName.isEmpty || isCreating)
                .buttonStyle(.borderedProminent)
            }

            Spacer()
        }
        .padding(20)
        .frame(width: 500, height: 350)
    }
}
