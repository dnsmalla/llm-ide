import SwiftUI

extension CodeAssistantPanel {
    // MARK: - Sheet Content Views

    private var showProjectMemorySheet: some View {
        ProjectMemoryView(api: api, repos: activeMemoryRepos, workspaceRoot: activeMemoryWorkspaceRoot)
            .environmentObject(theme)
    }

    private var showingIssueSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.createIssueArgs,
               let target = resolveIssueTarget() {
                CreateIssueSheet(
                    initialArgs: args,
                    projectName: target.label,
                    projectURL: target.projectURL,
                    provider: target.kind == .gitlab ? "GitLab" : "GitHub",
                    isAllowed: config.isAllowed(.createIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmCreateIssue(editedArgs, target: target)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Text("Add or activate a project in Settings → GitLab or GitHub.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Button("Close") { showingIssueSheet = false }
                }
                    .padding(20)
            }
        }
    }

    private var showingReviewCodeSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.triggerReviewCodeArgs {
                TriggerReviewCodeSheet(
                    plan: args.plan,
                    iid: args.iid,
                    issueTitle: recentIssues.first(where: { $0.iid == args.iid })?.title,
                    api: api
                )
                .environmentObject(config)
            } else {
                VStack(spacing: 12) {
                    Text("Review Code action unavailable.")
                        .font(.system(size: 13))
                    Button("Close") { showingReviewCodeSheet = false }
                }
                    .padding(20)
            }
        }
    }

    private var showingUpdateFileSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.updateFileArgs,
               let match = matchingAttachment(for: args.path) {
                UpdateFileSheet(
                    initialArgs: args,
                    originalContent: match.content,
                    displayPath: match.path,
                    onConfirm: { editedContent in
                        await confirmUpdateFile(args, finalContent: editedContent)
                    }
                )
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("File update unavailable")
                        .font(.headline)
                    Text("The agent proposed a path that doesn't match any attached file.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    if let pt = pendingTool, let args = pt.updateFileArgs {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Agent's path").font(.caption).foregroundStyle(.secondary)
                            Text(args.path)
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.secondary.opacity(0.1))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        if !attachments.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Attached files (\(attachments.count))").font(.caption).foregroundStyle(.secondary)
                                ForEach(attachments) { att in
                                    Text(att.path)
                                        .font(.system(size: 11, design: .monospaced))
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            .padding(6)
                            .background(Color.secondary.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    HStack {
                        Spacer()
                        Button("Close") { showingUpdateFileSheet = false }
                            .keyboardShortcut(.cancelAction)
                    }
                }
                .padding(20)
                .frame(minWidth: 460)
            }
        }
    }

    private var showingCommentSheetContent: some View {
        Group {
            if let pt = pendingTool,
               let args = pt.commentIssueArgs,
               let target = resolveIssueTarget() {
                CommentIssueSheet(
                    initialArgs: args,
                    projectName: target.label,
                    projectURL: target.projectURL,
                    provider: target.kind == .gitlab ? "GitLab" : "GitHub",
                    issueTitle: recentIssues.first(where: { $0.iid == args.iid })?.title,
                    isAllowed: config.isAllowed(.commentIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmCommentIssue(editedArgs, target: target)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Text("Add or activate a project in Settings → GitLab or GitHub.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Button("Close") { showingCommentSheet = false }
                }
                    .padding(20)
            }
        }
    }

    private var showingGetIssueSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.getIssueArgs, let target = resolveIssueTarget() {
                GetIssueSheet(
                    iid: args.iid,
                    projectId: target.projectId,
                    providerKind: target.kind,
                    onConfirm: {
                        confirmGetIssue()
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Button("Close") { showingGetIssueSheet = false }
                }
                    .padding(20)
            }
        }
    }

    private var showingUpdateIssueSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.updateIssueArgs, let target = resolveIssueTarget() {
                UpdateIssueSheet(
                    initialArgs: UpdateIssueSheet.Args(
                        iid: args.iid,
                        title: args.title,
                        body: args.description,
                        state: args.state,
                        labels: args.labels
                    ),
                    issueTitle: recentIssues.first(where: { $0.iid == args.iid })?.title,
                    projectId: target.projectId,
                    providerKind: target.kind,
                    isAllowed: config.isAllowed(.editIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmUpdateIssue(editedArgs, target: target)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Button("Close") { showingUpdateIssueSheet = false }
                }
                    .padding(20)
            }
        }
    }

    private var showingListIssuesSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.listIssuesArgs, let target = resolveIssueTarget() {
                ListIssuesSheet(
                    initialArgs: ListIssuesSheetArgs(
                        search: args.search,
                        state: args.state,
                        label: args.label
                    ),
                    projectId: target.projectId,
                    providerKind: target.kind,
                    onConfirm: {
                        showingListIssuesSheet = false
                        pendingTool = nil
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("No issue tracker available.")
                        .font(.system(size: 13))
                    Button("Close") { showingListIssuesSheet = false }
                }
                    .padding(20)
            }
        }
    }

    private func reportingFaultSheetContent(_ ctx: FaultReportContext) -> some View {
        Group {
            if let repoRoot = activeRepoRoot {
                let target = resolveIssueTarget()
                ReportFaultSheet(
                    prompt: ctx.prompt,
                    response: ctx.response,
                    repoRoot: repoRoot,
                    agent: config.activeCLI,
                    onSubmitted: { _ in reportingFault = nil },
                    onDismiss: { reportingFault = nil },
                    onFileIssue: target.map { tgt in
                        { fault in try await fileFaultAsIssue(fault, target: tgt) }
                    },
                    fileIssueTargetLabel: target?.label ?? ""
                )
                .environmentObject(theme)
                .environmentObject(config)
            } else {
                EmptyView()
            }
        }
    }

    private var showLibraryPickerContent: some View {
        LibraryPicker(
            allowed: [.code, .notes, .data],
            mode: .multi,
            title: "Add from Library"
        ) { items in
            attachNotice = nil
            var rejected: [String] = []
            for item in items where addFile(url: item.url) == .notText {
                rejected.append(item.name)
            }
            if !rejected.isEmpty {
                attachNotice = rejected.count == 1
                    ? "File: " + rejected[0] + " - cannot be attached (unsupported format)"
                    : "\(rejected.count) files couldn't be attached — unsupported binary formats"
            }
        }
    }

    private var showingGitOpSheetContent: some View {
        Group {
            if let pt = pendingTool, let g = pt.gitOpArgs {
                GitOpSheet(
                    args: g,
                    onConfirm: {
                        showingGitOpSheet = false
                        Task { await runGitOpFlow(g) }
                    },
                    onCancel: {
                        showingGitOpSheet = false
                        pendingTool = nil
                    }
                )
                .environmentObject(theme)
            } else {
                VStack(spacing: 12) {
                    Text("Git operation unavailable.")
                        .font(.system(size: 13))
                    Button("Close") { showingGitOpSheet = false }
                }
                    .padding(20)
                    .environmentObject(theme)
            }
        }
    }

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
