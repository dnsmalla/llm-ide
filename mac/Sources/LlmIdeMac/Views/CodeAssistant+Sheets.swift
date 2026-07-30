import SwiftUI

extension CodeAssistantPanel {
    var showingCreatePRSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.createPRArgs, let target = resolveIssueTarget() {
                // Build description with file changes for File → PR automation
                let enhancedDescription: String = {
                    let base = args.description.isEmpty ? "" : args.description + "\n\n"
                    if !modifiedFiles.isEmpty {
                        let fileList = modifiedFiles.sorted().map { "• \($0)" }.joined(separator: "\n")
                        return base + "### Modified Files\n" + fileList
                    }
                    return base
                }()

                PRCreationSheet(
                    initialArgs: PRCreationSheet.CreatePRArgs(
                        title: args.title,
                        description: enhancedDescription,
                        sourceBranch: args.sourceBranch,
                        targetBranch: args.targetBranch,
                        labels: args.labels,
                        assignee: args.assignee
                    ),
                    projectName: target.label,
                    projectURL: target.projectURL,
                    provider: target.kind == .gitlab ? "GitLab" : "GitHub",
                    isAllowed: config.isAllowed(.createPR, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmPRCreation(editedArgs, target: target)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("PR/MR creation unavailable.")
                        .font(.system(size: 13))
                    Text("Add or activate a project in Settings → GitLab or GitHub.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Button("Close") { showingCreatePRSheet = false }
                }
                    .padding(20)
            }
        }
    }
}
