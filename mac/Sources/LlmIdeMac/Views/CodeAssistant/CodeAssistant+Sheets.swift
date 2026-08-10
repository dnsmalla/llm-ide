import SwiftUI

extension CodeAssistantPanel {

    /// Shared "action unavailable" fallback shown when a pendingTool's args
    /// are missing or its precondition (target/attachment/branch context)
    /// didn't resolve — replaces the near-identical VStack the sheet
    /// contents below each used to build by hand.
    @ViewBuilder
    private func unavailableSheet(_ title: String, hint: String? = nil, dismiss: @escaping () -> Void) -> some View {
        VStack(spacing: 12) {
            Text(title).font(.system(size: 13))
            if let hint {
                Text(hint)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Button("Close", action: dismiss)
        }
        .padding(20)
    }

    private static let noIssueTrackerHint = "Add or activate a project in Settings → GitLab or GitHub."

    var showProjectMemorySheet: some View {
        ProjectMemoryView(api: api, repos: activeMemoryRepos, workspaceRoot: activeMemoryWorkspaceRoot)
            .environmentObject(theme)
    }

    var showingIssueSheetContent: some View {
        Group {
            if let pt = agent.pendingTool,
               let args = pt.createIssueArgs,
               let target = resolveIssueTarget() {
                CreateIssueSheet(
                    initialArgs: args,
                    projectName: target.label,
                    projectURL: target.projectURL,
                    provider: target.kind.displayName,
                    isAllowed: config.isAllowed(.createIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmCreateIssue(editedArgs, target: target)
                    }
                )
            } else {
                unavailableSheet("No issue tracker available.", hint: Self.noIssueTrackerHint) {
                    sheets.showingIssueSheet = false
                }
            }
        }
    }

    var showingReviewCodeSheetContent: some View {
        Group {
            if let pt = agent.pendingTool,
               let args = pt.triggerReviewCodeArgs {
                TriggerReviewCodeSheet(
                    plan: args.plan,
                    iid: args.iid,
                    issueTitle: agent.recentIssues.first(where: { $0.iid == args.iid })?.title,
                    api: api
                )
                .environmentObject(config)
            } else {
                unavailableSheet("Review Code action unavailable.") {
                    sheets.showingReviewCodeSheet = false
                }
            }
        }
    }

    var showingUpdateFileSheetContent: some View {
        Group {
            if let pt = agent.pendingTool,
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
                    if let pt = agent.pendingTool, let args = pt.updateFileArgs {
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
                        if !attachmentState.attachments.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Attached files (\(attachmentState.attachments.count))").font(.caption).foregroundStyle(.secondary)
                                ForEach(attachmentState.attachments) { att in
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
                        Button("Close") { sheets.showingUpdateFileSheet = false }
                            .keyboardShortcut(.cancelAction)
                    }
                }
                .padding(20)
                .frame(minWidth: 460)
            }
        }
    }

    var showingCommentSheetContent: some View {
        Group {
            if let pt = agent.pendingTool,
               let args = pt.commentIssueArgs,
               let target = resolveIssueTarget() {
                CommentIssueSheet(
                    initialArgs: args,
                    projectName: target.label,
                    projectURL: target.projectURL,
                    provider: target.kind.displayName,
                    issueTitle: agent.recentIssues.first(where: { $0.iid == args.iid })?.title,
                    isAllowed: config.isAllowed(.commentIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmCommentIssue(editedArgs, target: target)
                    }
                )
            } else {
                unavailableSheet("No issue tracker available.", hint: Self.noIssueTrackerHint) {
                    sheets.showingCommentSheet = false
                }
            }
        }
    }

    var showingGetIssueSheetContent: some View {
        Group {
            if let pt = agent.pendingTool, let args = pt.getIssueArgs, let target = resolveIssueTarget() {
                GetIssueSheet(
                    iid: args.iid,
                    projectId: target.projectId,
                    providerKind: target.kind,
                    onConfirm: {
                        sheets.showingGetIssueSheet = false
                        agent.pendingTool = nil
                    }
                )
            } else {
                unavailableSheet("No issue tracker available.") {
                    sheets.showingGetIssueSheet = false
                }
            }
        }
    }

    var showingUpdateIssueSheetContent: some View {
        Group {
            if let pt = agent.pendingTool, let args = pt.updateIssueArgs, let target = resolveIssueTarget() {
                UpdateIssueSheet(
                    initialArgs: UpdateIssueSheet.Args(
                        iid: args.iid,
                        title: args.title,
                        body: args.description,
                        state: args.state,
                        labels: args.labels
                    ),
                    issueTitle: agent.recentIssues.first(where: { $0.iid == args.iid })?.title,
                    projectId: target.projectId,
                    providerKind: target.kind,
                    isAllowed: config.isAllowed(.editIssue, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmUpdateIssue(editedArgs, target: target)
                    }
                )
            } else {
                unavailableSheet("No issue tracker available.") {
                    sheets.showingUpdateIssueSheet = false
                }
            }
        }
    }

    var showingListIssuesSheetContent: some View {
        Group {
            if let pt = agent.pendingTool, let args = pt.listIssuesArgs, let target = resolveIssueTarget() {
                ListIssuesSheet(
                    initialArgs: ListIssuesSheetArgs(
                        search: args.search,
                        state: args.state,
                        label: args.label
                    ),
                    projectId: target.projectId,
                    providerKind: target.kind,
                    onConfirm: {
                        sheets.showingListIssuesSheet = false
                        agent.pendingTool = nil
                    }
                )
            } else {
                unavailableSheet("No issue tracker available.") {
                    sheets.showingListIssuesSheet = false
                }
            }
        }
    }

    var showingCreateBranchSheetContent: some View {
        Group {
            if let pt = agent.pendingTool, let args = pt.createBranchArgs {
                BranchCreationSheet(
                    initialArgs: BranchCreationSheet.CreateBranchArgs(
                        branch: args.branch,
                        startPoint: args.startPoint
                    ),
                    currentBranch: sheets.branchSheetContext?.currentBranch,
                    onConfirm: { editedArgs in
                        await confirmBranchCreation(editedArgs)
                    }
                )
            } else {
                unavailableSheet("Branch creation unavailable.") {
                    sheets.showingCreateBranchSheet = false
                }
            }
        }
    }

    func reportingFaultSheetContent(_ ctx: FaultReportContext) -> some View {
        Group {
            if let repoRoot = activeRepoRoot {
                let target = resolveIssueTarget()
                ReportFaultSheet(
                    prompt: ctx.prompt,
                    response: ctx.response,
                    repoRoot: repoRoot,
                    agent: config.activeCLI,
                    onSubmitted: { _ in sheets.reportingFault = nil },
                    onDismiss: { sheets.reportingFault = nil },
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

    var showLibraryPickerContent: some View {
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
                    ? "File: " + rejected[0] + " - can not be attached"
                    : "\(rejected.count) files couldn't be attached — images and binary files aren't supported in chat yet."
            }
        }
    }

    var showingGitOpSheetContent: some View {
        Group {
            if let pt = agent.pendingTool, let g = pt.gitOpArgs {
                GitOpSheet(
                    args: g,
                    onConfirm: {
                        sheets.showingGitOpSheet = false
                        Task { await runGitOpFlow(g) }
                    },
                    onCancel: {
                        sheets.showingGitOpSheet = false
                        agent.pendingTool = nil
                    }
                )
                .environmentObject(theme)
            } else {
                unavailableSheet("Git operation unavailable.") {
                    sheets.showingGitOpSheet = false
                }
                .environmentObject(theme)
            }
        }
    }



    // MARK: - Fault → Issue routing

    /// Resolves the currently-active issue tracker target — used by the
    /// "Also file as issue" toggle in ReportFaultSheet. Precedence matches
    /// `config.activeRepoLocalURL`: GitLab project first, then GitHub.
    /// Returns nil when nothing is configured or the active project is
    /// missing the bits we need (token, resolved ID).
    func resolveIssueTarget() -> IssueTarget? {
        if !config.gitLabToken.isEmpty,
           let p = config.gitLabSavedProjects.first(where: { $0.isActive }),
           let id = p.resolvedId
        {
            let display = !p.displayName.isEmpty ? p.displayName
                : (URL(string: p.url)?.lastPathComponent ?? "project")
            return .init(kind: .gitlab, projectId: String(id), label: "\(display) (GitLab)", projectURL: p.url)
        }
        if !config.gitHubToken.isEmpty,
           let r = config.gitHubSavedRepos.first(where: { $0.isActive }),
           let (owner, name) = GitHubClient.ownerAndName(from: r.url)
        {
            let pid = "\(owner)/\(name)"
            return .init(kind: .github, projectId: pid, label: "\(pid) (GitHub)", projectURL: r.url)
        }
        return nil
    }

    /// Build a RepoIssuePayload from the local FaultReport and POST it via
    /// the matching RepoBackend. Returns the new issue's web URL on
    /// success.
    func fileFaultAsIssue(_ fault: FaultReport, target: IssueTarget) async throws -> URL? {
        let title = fault.notes
            .split(whereSeparator: { $0.isNewline })
            .first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? "Fault report"
        let body = """
        **Severity:** \(fault.severity.displayName)
        **Agent:** \(fault.agent)
        **App version:** \(fault.appVersion)
        \(fault.gitHead.map { "**Git HEAD:** `\($0)`" } ?? "")

        ### Notes
        \(fault.notes)

        ### Prompt
        ```
        \(fault.prompt.prefix(4000))
        ```

        ### Response
        \(fault.response.prefix(8000))
        """
        // "bug" stays as the conventional issue-tracker label so existing
        // tracker filters/automation keep matching.
        let labels = fault.tags + ["bug", "meet-notes"]
        let payload = RepoIssuePayload(
            title: String(title.prefix(140)),
            body: body,
            labels: labels
        )
        let client = RepoBackendFactory.backend(for: target.kind, config: config)
        let issue = try await client.createIssue(projectId: target.projectId, payload: payload)
        return URL(string: issue.webUrl)
    }

    /// Target descriptor returned by `resolveIssueTarget`.
    internal struct IssueTarget {
        let kind: RepoBackendKind
        let projectId: String
        let label: String
        let projectURL: String
    }


    var showingCreatePRSheetContent: some View {
        Group {
            if let pt = agent.pendingTool, let args = pt.createPRArgs, let target = resolveIssueTarget() {
                // Build description with file changes for File → PR automation
                let enhancedDescription: String = {
                    let base = args.description.isEmpty ? "" : args.description + "\n\n"
                    if !attachmentState.modifiedFiles.isEmpty {
                        let fileList = attachmentState.modifiedFiles.sorted().map { "• \($0)" }.joined(separator: "\n")
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
                    provider: target.kind.displayName,
                    isAllowed: config.isAllowed(.createPR, provider: target.kind),
                    onConfirm: { editedArgs in
                        await confirmPRCreation(editedArgs, target: target)
                    }
                )
            } else {
                unavailableSheet("PR/MR creation unavailable.", hint: Self.noIssueTrackerHint) {
                    sheets.showingCreatePRSheet = false
                }
            }
        }
    }

}
