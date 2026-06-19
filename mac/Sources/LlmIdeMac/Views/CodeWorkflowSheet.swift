import SwiftUI

/// Multi-step sheet for the code-change workflow (GitLab or GitHub).
/// Steps: Create Issue → Create Branch → Generate Changes → Review & Commit → Push & MR/PR → Done
struct CodeWorkflowSheet: View {
    @StateObject private var svc: CodeWorkflowService
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appConfig: AppConfig
    @EnvironmentObject private var theme: ThemeStore
    @State private var showExistingPicker = false
    /// Backend-neutral descriptor — selects GitLab vs GitHub and carries the
    /// state the "pick existing issue" picker needs.
    private let target: CodeWorkflowTarget
    private var kind: RepoBackendKind { target.kind }
    private let prefill: (number: Int, plan: String)?

    /// In-progress state from a Quick Fix run that hit a failure and is
    /// handing off to the guided flow. Optional; nil for fresh starts.
    private let resumeFrom: ResumeState?

    struct ResumeState {
        let branchName: String
        let commitMessage: String
        let mrTitle: String
        let mrDescription: String
        let aiPrompt: String
        let createdMR: RepoMergeRequest?
        let landAtStep: CodeWorkflowService.Step
    }

    init(api: LlmIdeAPIClient,
         target: CodeWorkflowTarget,
         prefill: (number: Int, plan: String)? = nil,
         resumeFrom: ResumeState? = nil) {
        self.target = target
        _svc = StateObject(wrappedValue: CodeWorkflowService(
            backend: target.backend,
            projectId: target.projectId,
            localURL: target.localURL,
            defaultBranch: target.defaultBranch,
            displayName: target.displayName,
            gitPushToken: target.pushToken,
            api: api))
        self.prefill = prefill
        self.resumeFrom = resumeFrom
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            stepIndicator
            Divider()
            stepContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            footer
        }
        .frame(minWidth: 640, minHeight: 520)
        .task {
            if let pf = prefill, svc.createdIssue == nil {
                await svc.bootstrapFromExistingIssue(number: pf.number, plan: pf.plan)
            }
            // After bootstrap, optionally overlay in-progress state from
            // a Quick Fix run that's handing off to us.
            if let r = resumeFrom {
                svc.branchName = r.branchName
                svc.commitMessage = r.commitMessage
                svc.mrTitle = r.mrTitle
                svc.mrDescription = r.mrDescription
                svc.aiPrompt = r.aiPrompt
                svc.createdMR = r.createdMR
                svc.currentStep = r.landAtStep
            }
        }
        .sheet(isPresented: $showExistingPicker) {
            ExistingIssuePicker(
                backend: target.backend,
                projectId: target.projectId,
                displayName: target.displayName,
                isResolved: target.isResolved,
                onSelect: { issue in
                    showExistingPicker = false
                    Task {
                        await svc.bootstrapFromExistingIssue(
                            number: issue.number,
                            plan: issue.body ?? issue.title
                        )
                    }
                },
                onCancel: { showExistingPicker = false }
            )
        }
    }

    // MARK: - Header

    private var header: some View {
        SheetHeader(
            title: "New Change",
            subtitle: svc.projectDisplayName,
            cancelDisabled: svc.busy,
            onCancel: { dismiss() }
        )
    }

    // MARK: - Step indicator

    private var stepIndicator: some View {
        HStack(spacing: 0) {
            ForEach(CodeWorkflowService.Step.allCases) { step in
                stepPill(step)
                if step != .done {
                    Rectangle()
                        .fill(step.rawValue < svc.currentStep.rawValue ? theme.current.accent : Color.secondary.opacity(0.3))
                        .frame(maxWidth: .infinity, maxHeight: 2)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private func stepPill(_ step: CodeWorkflowService.Step) -> some View {
        let isDone = step.rawValue < svc.currentStep.rawValue
        let isCurrent = step == svc.currentStep
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(isDone ? theme.current.accent : isCurrent ? theme.current.accent.opacity(0.15) : Color.secondary.opacity(0.1))
                    .frame(width: 28, height: 28)
                if isDone {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.white)
                } else {
                    Image(systemName: step.icon)
                        .font(.system(size: 11))
                        .foregroundStyle(isCurrent ? theme.current.accent : Color.secondary)
                }
            }
            Text(step.title)
                .font(.system(size: 9))
                .foregroundStyle(isCurrent ? .primary : .secondary)
                .lineLimit(1)
        }
    }

    // MARK: - Step content

    @ViewBuilder
    private var stepContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let err = svc.stepError {
                    StatusBanner(severity: .error, message: err)
                }
                if let info = svc.stepInfo {
                    StatusBanner(severity: .info, message: info)
                }
                switch svc.currentStep {
                case .issue:    issueStep
                case .branch:   branchStep
                case .generate: generateStep
                case .review:   reviewStep
                case .push:     pushStep
                case .done:     doneStep
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Step views

    private var issueStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            stepHeading(icon: "tag", title: "Create a \(kind.displayName) Issue", subtitle: "Describe what needs to change")
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Title")
                TextField("Brief description of the change", text: $svc.issueTitle)
                    .textFieldStyle(.roundedBorder)
                    .disabled(svc.busy)
            }
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Description (optional)")
                TextEditor(text: $svc.issueDescription)
                    .font(.body)
                    .frame(minHeight: 100)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                    .disabled(svc.busy)
            }
            HStack(spacing: 8) {
                VStack { Divider() }
                Text("OR")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                VStack { Divider() }
            }
            .padding(.vertical, 4)
            Button {
                showExistingPicker = true
            } label: {
                HStack {
                    Image(systemName: "list.bullet.rectangle")
                    Text("Pick existing issue")
                    Spacer()
                    Image(systemName: "arrow.right")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.bordered)
            .disabled(svc.busy)
        }
    }

    private var branchStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let issue = svc.createdIssue {
                issueBadge(issue)
            }
            stepHeading(icon: "arrow.triangle.branch", title: "Create Branch",
                        subtitle: "A feature branch will be created locally and on \(kind.displayName)")
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Branch name")
                TextField("e.g. issue-42-fix-login-flow", text: $svc.branchName)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .disabled(svc.busy)
            }
            HStack(spacing: 6) {
                Image(systemName: "info.circle")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                Text("Base: **\(svc.defaultBranch)**  →  \(svc.localURL.lastPathComponent)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var generateStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let issue = svc.createdIssue { issueBadge(issue) }
            stepHeading(icon: "wand.and.stars", title: "Generate Code Changes",
                        subtitle: "Claude will analyse the task and propose file changes")
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Prompt for AI")
                TextEditor(text: $svc.aiPrompt)
                    .font(.body)
                    .frame(minHeight: 100)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                    .disabled(svc.busy)
            }
            if svc.busy {
                CliProgressView(
                    elapsed: svc.cliElapsedSeconds,
                    logTail: svc.cliLogTail,
                    onCancel: { svc.cancelCli() }
                )
            } else if !svc.diffFiles.isEmpty {
                generatedFilesPreview
            }
            // When the CLI said "already done" (stepInfo set on .generate),
            // offer a clear path to skip the rest of the workflow.
            if !svc.busy, svc.stepInfo != nil {
                HStack {
                    Spacer()
                    Button("Skip — mark issue done") {
                        Task { await svc.skipToDone() }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private var generatedFilesPreview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Generated \(svc.diffFiles.count) file(s)")
                .font(.subheadline.weight(.medium))
            ForEach(svc.diffFiles) { file in
                DisclosureGroup {
                    ScrollView {
                        Text(file.rawDiff)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 200)
                    .background(Color(.textBackgroundColor))
                    .cornerRadius(4)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: file.isNew ? "plus.circle.fill" : "pencil.circle.fill")
                            .foregroundStyle(file.isNew ? theme.current.success : theme.current.info)
                            .font(.caption)
                        Text(file.path)
                            .font(.system(size: 12, design: .monospaced))
                        Spacer()
                        Text(file.isNew ? "new" : "modify")
                            .font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background((file.isNew ? theme.current.success : theme.current.info).opacity(0.12))
                            .foregroundStyle(file.isNew ? theme.current.success : theme.current.info)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var reviewStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let issue = svc.createdIssue { issueBadge(issue) }
            stepHeading(icon: "doc.text.magnifyingglass", title: "Review & Commit",
                        subtitle: "Review the generated changes and enter a commit message")
            if !svc.diffFiles.isEmpty {
                generatedFilesPreview
            } else {
                Text("No AI-generated files. Manually edit files in the Code tab and return here to commit.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            // Refinement section — lets the user keep iterating with the
            // CLI on top of the current diff without going back to the
            // Generate step.
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Refine — describe additional changes (optional)")
                TextEditor(text: $svc.refinementPrompt)
                    .font(.body)
                    .frame(minHeight: 70)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                    .disabled(svc.busy)
                HStack {
                    Spacer()
                    Button(svc.busy ? "Regenerating…" : "Regenerate with Refinement") {
                        Task { await svc.regenerateWithRefinement(activeCLI: appConfig.activeCLI) }
                    }
                    .disabled(svc.busy ||
                              svc.refinementPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Commit message")
                TextField("e.g. fix: resolve login flow (#42)", text: $svc.commitMessage)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .disabled(svc.busy)
            }
            if svc.busy {
                CliProgressView(
                    elapsed: svc.cliElapsedSeconds,
                    logTail: svc.cliLogTail,
                    onCancel: { svc.cancelCli() }
                )
            }
        }
    }

    private var pushStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let issue = svc.createdIssue { issueBadge(issue) }
            stepHeading(icon: "icloud.and.arrow.up", title: "Push & Create \(kind.changeRequestNoun)",
                        subtitle: "Push the branch and open a \(kind.changeRequestAbbrev) on \(kind.displayName)")
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("\(kind.changeRequestAbbrev) title")
                TextField("\(kind.changeRequestNoun) title", text: $svc.mrTitle)
                    .textFieldStyle(.roundedBorder)
                    .disabled(svc.busy)
            }
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("\(kind.changeRequestAbbrev) description")
                TextEditor(text: $svc.mrDescription)
                    .font(.body)
                    .frame(minHeight: 80)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                    .disabled(svc.busy)
            }
            if svc.busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Pushing…").foregroundStyle(.secondary).font(.callout)
                }
            }
        }
    }

    private var doneStep: some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(theme.current.success)
            Text("Change submitted!")
                .font(.title2.weight(.semibold))

            VStack(alignment: .leading, spacing: 10) {
                if let issue = svc.createdIssue {
                    summaryRow(icon: "number.circle.fill", label: "Issue") {
                        HStack(spacing: 6) {
                            Text("#\(issue.number) · \(issue.title)")
                                .font(.callout)
                                .lineLimit(1)
                            Button {
                                if let url = URL(string: issue.webUrl) { NSWorkspace.shared.open(url) }
                            } label: {
                                Label("View Issue", systemImage: "arrow.up.right.square")
                                    .labelStyle(.iconOnly)
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
                if !svc.branchName.isEmpty {
                    summaryRow(icon: "arrow.triangle.branch", label: "Branch") {
                        Text(svc.branchName)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
                summaryRow(icon: "icloud.and.arrow.up.fill", label: kind.changeRequestAbbrev) {
                    if let mr = svc.createdMR {
                        HStack(spacing: 6) {
                            Text(mr.title).font(.callout).lineLimit(1)
                            Button {
                                if let url = URL(string: mr.webUrl) { NSWorkspace.shared.open(url) }
                            } label: {
                                Label("View \(kind.changeRequestAbbrev)", systemImage: "arrow.up.right.square")
                                    .labelStyle(.iconOnly)
                            }
                            .buttonStyle(.borderless)
                        }
                    } else {
                        Text("No \(kind.changeRequestAbbrev) opened")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                summaryRow(icon: "doc.text.fill", label: "Files") {
                    Text("\(svc.diffFiles.count) file\(svc.diffFiles.count == 1 ? "" : "s")")
                        .font(.callout)
                }
                summaryRow(icon: "circle.fill", label: "Status") {
                    issueStatusPill
                }
            }
            .padding(14)
            .frame(maxWidth: 460, alignment: .leading)
            .background(Color.secondary.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    @ViewBuilder
    private func summaryRow<Content: View>(icon: String, label: String, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 60, alignment: .leading)
            content()
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var issueStatusPill: some View {
        let closed = svc.issueClosedSuccessfully
        Text(closed ? "Closed" : "Open")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background((closed ? theme.current.success : theme.current.warning).opacity(0.18))
            .foregroundStyle(closed ? theme.current.success : theme.current.warning)
            .clipShape(Capsule())
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            if svc.currentStep != .issue && svc.currentStep != .done {
                Button("Back") { goBack() }
                    .disabled(svc.busy)
            }
            Spacer()
            if svc.currentStep == .done {
                Button("Close") { dismiss() }
                    .buttonStyle(.borderedProminent)
            } else {
                primaryButton
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch svc.currentStep {
        case .issue:
            Button("Create Issue") { Task { await svc.createIssue() } }
                .buttonStyle(.borderedProminent)
                .disabled(svc.busy || svc.issueTitle.trimmingCharacters(in: .whitespaces).isEmpty)
        case .branch:
            Button("Create Branch") { Task { await svc.createBranch() } }
                .buttonStyle(.borderedProminent)
                .disabled(svc.busy || svc.branchName.trimmingCharacters(in: .whitespaces).isEmpty)
        case .generate:
            if svc.diffFiles.isEmpty {
                Button("Generate Changes") { Task { await svc.generateChanges(activeCLI: appConfig.activeCLI) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(svc.busy || svc.aiPrompt.trimmingCharacters(in: .whitespaces).isEmpty)
            } else {
                Button("Use These Changes") { svc.currentStep = .review }
                    .buttonStyle(.borderedProminent)
                    .disabled(svc.busy)
            }
        case .review:
            Button(svc.busy ? "Committing…" : "Commit Changes") { Task { await svc.commitChanges() } }
                .buttonStyle(.borderedProminent)
                .disabled(svc.busy || svc.commitMessage.trimmingCharacters(in: .whitespaces).isEmpty)
        case .push:
            HStack(spacing: 8) {
                // Surface a "Retry MR only" path when the previous
                // attempt left the branch pushed but the MR uncreated.
                // Safe to call repeatedly — listMergeRequests detects
                // an existing MR and adopts it instead of duplicating.
                if svc.stepError != nil {
                    Button("Retry \(kind.changeRequestAbbrev) only") { Task { await svc.retryMROnly() } }
                        .buttonStyle(.bordered)
                        .disabled(svc.busy)
                }
                Button(svc.busy ? "Pushing…" : "Push & Create \(kind.changeRequestAbbrev)") { Task { await svc.pushAndCreateMR() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(svc.busy || svc.mrTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        case .done:
            EmptyView()
        }
    }

    // MARK: - Reusable sub-views

    @ViewBuilder
    private func stepHeading(icon: String, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(theme.current.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private func issueBadge(_ issue: RepoIssue) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "number.circle.fill").foregroundStyle(theme.current.accent).font(.caption)
            Text("#\(issue.number): \(issue.title)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(theme.current.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }


    // MARK: - Navigation

    private func goBack() {
        guard svc.currentStep.rawValue > 0 else { return }
        svc.stepError = nil
        svc.stepInfo = nil
        svc.currentStep = CodeWorkflowService.Step(rawValue: svc.currentStep.rawValue - 1) ?? .issue
    }
}
