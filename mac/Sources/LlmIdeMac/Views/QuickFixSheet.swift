import SwiftUI
import RepoKit
import AppKit

/// Single-screen end-to-end Code workflow for small fixes.
/// Skips the multi-step UI: takes a plan, runs branch→generate→commit→push→MR
/// in sequence, and surfaces the result inline. Errors offer a one-click
/// switch to the guided `CodeWorkflowSheet`.
struct QuickFixSheet: View {
    @StateObject private var svc: CodeWorkflowService
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appConfig: AppConfig
    @EnvironmentObject private var theme: ThemeStore
    private let prefill: (number: Int, plan: String)?
    private let api: LlmIdeAPIClient
    private let target: CodeWorkflowTarget
    private var kind: RepoBackendKind { target.kind }

    @State private var bootstrapped = false
    @State private var switchToGuided = false
    @State private var showIssuePicker = false

    init(api: LlmIdeAPIClient, target: CodeWorkflowTarget, prefill: (number: Int, plan: String)? = nil) {
        _svc = StateObject(wrappedValue: CodeWorkflowService(
            backend: target.backend,
            projectId: target.projectId,
            localURL: target.localURL,
            defaultBranch: target.defaultBranch,
            displayName: target.displayName,
            gitPushToken: target.pushToken,
            api: api))
        self.api = api
        self.target = target
        self.prefill = prefill
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 600, minHeight: 480)
        .task {
            guard !bootstrapped else { return }
            bootstrapped = true
            if let pf = prefill {
                await svc.bootstrapFromExistingIssue(number: pf.number, plan: pf.plan)
            } else {
                showIssuePicker = true
            }
        }
        .sheet(isPresented: $showIssuePicker) {
            ExistingIssuePicker(
                backend: target.backend,
                projectId: target.projectId,
                displayName: target.displayName,
                isResolved: target.isResolved,
                onSelect: { issue in
                    showIssuePicker = false
                    Task {
                        await svc.bootstrapFromExistingIssue(
                            number: issue.number,
                            plan: issue.body ?? issue.title
                        )
                    }
                },
                onCancel: {
                    showIssuePicker = false
                    if svc.createdIssue == nil { dismiss() }
                }
            )
        }
        .sheet(isPresented: $switchToGuided, onDismiss: { dismiss() }) {
            CodeWorkflowSheet(
                api: api,
                target: target,
                prefill: svc.createdIssue.map { (number: $0.number, plan: svc.aiPrompt) },
                // Carry forward in-progress state so the guided sheet
                // lands on the step the Quick Fix run reached and
                // doesn't re-create the branch / re-generate the diff.
                resumeFrom: CodeWorkflowSheet.ResumeState(
                    branchName: svc.branchName,
                    commitMessage: svc.commitMessage,
                    mrTitle: svc.mrTitle,
                    mrDescription: svc.mrDescription,
                    aiPrompt: svc.aiPrompt,
                    createdMR: svc.createdMR,
                    landAtStep: svc.currentStep
                )
            )
            .environmentObject(appConfig)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "bolt.fill")
                .foregroundStyle(theme.current.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text("Quick Fix").font(.headline)
                Text(target.displayName).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let issue = svc.createdIssue {
                Text("#\(issue.number)")
                    .font(.caption.monospaced())
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(theme.current.accent.opacity(0.12))
                    .clipShape(Capsule())
            }
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .disabled(svc.busy)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
    }

    // MARK: - Main content

    @ViewBuilder
    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let err = svc.stepError {
                    StatusBanner(severity: .error, message: err)
                }
                if svc.currentStep == .done {
                    doneCard
                } else {
                    planEditor
                    if svc.busy {
                        CliProgressView(
                            elapsed: svc.cliElapsedSeconds,
                            logTail: svc.cliLogTail,
                            onCancel: { svc.cancelCli() }
                        )
                    }
                    if let info = svc.stepInfo {
                        Text(info)
                            .font(.callout)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(theme.current.info.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var planEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Plan")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            TextEditor(text: $svc.aiPrompt)
                .font(.body)
                .frame(minHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                .disabled(svc.busy)
        }
    }

    private var doneCard: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(theme.current.success)
            Text("Done!").font(.title2.weight(.semibold))
            VStack(alignment: .leading, spacing: 6) {
                if !svc.branchName.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
                        Text(svc.branchName).font(.system(.callout, design: .monospaced))
                    }
                }
                if let mr = svc.createdMR {
                    HStack(spacing: 6) {
                        Image(systemName: "icloud.and.arrow.up.fill").foregroundStyle(.secondary)
                        Text(mr.title).font(.callout).lineLimit(1)
                    }
                }
            }
            .padding(.vertical, 6)
            HStack(spacing: 10) {
                if let mr = svc.createdMR, let url = URL(string: mr.webUrl) {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label("View \(kind.changeRequestAbbrev)", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.borderedProminent)
                }
                if let issue = svc.createdIssue, let url = URL(string: issue.webUrl) {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label("Open Issue", systemImage: "number")
                    }
                }
                Button("Close") { dismiss() }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }

    // MARK: - Footer

    @ViewBuilder
    private var footer: some View {
        HStack {
            if svc.stepError != nil {
                Button {
                    switchToGuided = true
                } label: {
                    Label("Switch to Guided", systemImage: "list.bullet.rectangle")
                }
            }
            Spacer()
            if svc.currentStep != .done {
                Button(svc.busy ? "Running…" : "Run") {
                    Task { await svc.runEndToEnd(activeCLI: appConfig.activeCLI) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(svc.busy
                          || svc.createdIssue == nil
                          || svc.aiPrompt.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 14)
    }

}
