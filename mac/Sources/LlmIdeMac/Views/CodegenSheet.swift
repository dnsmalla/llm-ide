import SwiftUI

/// Sheet that generates code for a single task and submits the result
/// to the review queue.  Workflow:
///   1. On open, kick off /kb/generate-code (LLM, ~30-90s).
///   2. Render a per-file preview with kind chip (create/modify) and
///      a folded source view.
///   3. User picks a target repo from the server-side allow-list +
///      optionally enables draft-PR with GitHub creds.
///   4. Submit → POST /kb/review/submit (kind=codegen-apply).  Server
///      runs guardrails; the user must approve in ReviewView before
///      anything lands on disk.
struct CodegenSheet: View {
    let api: LlmIdeAPIClient
    let plan: Plan
    let task: PlanTask
    let language: String?
    /// Callback fired after a successful submit so the parent can
    /// switch the user over to the Review tab.
    let onSubmitted: (LlmIdeAPIClient.ReviewItem) -> Void
    let onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var generating = true
    @State private var generationError: String?
    @State private var result: LlmIdeAPIClient.CodegenResult?

    @State private var allowedRepos: [LlmIdeAPIClient.UserRepo] = []
    @State private var selectedRepo: String = ""
    @State private var openPR: Bool = false
    @State private var ghRepo: String = ""
    @State private var ghToken: String = ""
    @State private var baseBranch: String = "main"
    @State private var submitting = false
    @State private var submitError: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(theme.current.border)
            if generating {
                generatingState
            } else if let err = generationError {
                errorState(err)
            } else if let r = result {
                content(r)
            }
            Divider().background(theme.current.border)
            footer
        }
        .frame(minWidth: 720, minHeight: 540)
        .background(theme.current.body)
        .task { await runGeneration() }
        .task { await loadAllowedRepos() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                SectionLabel("Generate code", size: 12)
                Text(task.title)
                    .font(Typography.title)
                    .foregroundStyle(theme.current.text)
                    .lineLimit(2)
                Text("Plan: \(plan.title)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer()
            Button("Close", action: onDismiss)
                .keyboardShortcut(.cancelAction)
        }
        .padding(Spacing.lg)
    }

    @ViewBuilder
    private var generatingState: some View {
        VStack(spacing: Spacing.md) {
            ProgressView().controlSize(.large)
            Text("Generating code…")
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
            Text("This calls Claude through your local CLI and can take 30–90s for a non-trivial task.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func errorState(_ msg: String) -> some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32))
                .foregroundStyle(theme.current.danger)
            Text("Generation failed")
                .font(Typography.bodyStrong)
            Text(msg)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Spacing.lg)
            Button("Try again") { Task { await runGeneration() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func content(_ r: LlmIdeAPIClient.CodegenResult) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                summaryBlock(r)
                fileList("Source files", files: r.files)
                if !r.tests.isEmpty {
                    fileList("Tests", files: r.tests)
                }
                targetBlock
            }
            .padding(Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func summaryBlock(_ r: LlmIdeAPIClient.CodegenResult) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel("Summary", size: 12)
            Text(r.summary.isEmpty ? "(no summary)" : r.summary)
                .font(Typography.body)
                .foregroundStyle(theme.current.text)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                KindChip(label: "\(r.files.count) source", palette: .info)
                KindChip(label: "\(r.tests.count) test", palette: .neutral)
            }
            if let notes = r.notes, !notes.isEmpty {
                Text(notes)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.top, 4)
            }
        }
    }

    private func fileList(_ title: String, files: [LlmIdeAPIClient.CodegenFile]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            ForEach(files) { f in
                DisclosureGroup {
                    ScrollView {
                        Text(f.content)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(theme.current.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 280)
                    .background(theme.current.body)
                    .cornerRadius(4)
                } label: {
                    HStack(spacing: 6) {
                        KindChip(label: f.kind, palette: f.kind == "create" ? .info : .brand)
                        Text(f.path)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(theme.current.text)
                        Spacer()
                        Text("\(f.content.count) chars · \(f.language)")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .card(padding: Spacing.md)
    }

    private var targetBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("Target", size: 12)

            if allowedRepos.isEmpty {
                Text("No allow-listed repos yet. Add one via /auth/me/repos (Settings → Connectors in the Chrome extension still has the form; Mac UI coming).")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Picker("Repo path", selection: $selectedRepo) {
                    Text("Select a repo…").tag("")
                    ForEach(allowedRepos) { r in
                        Text(r.label ?? r.path).tag(r.path)
                    }
                }
                .pickerStyle(.menu)
            }

            Toggle("Open a draft pull request", isOn: $openPR)
                .toggleStyle(.switch)
                .disabled(selectedRepo.isEmpty)

            if openPR {
                VStack(alignment: .leading, spacing: 4) {
                    TextField("GitHub repo (owner/name)", text: $ghRepo)
                        .textFieldStyle(.roundedBorder)
                    SecureField("GitHub token (PAT with repo scope)", text: $ghToken)
                        .textFieldStyle(.roundedBorder)
                    TextField("Base branch", text: $baseBranch)
                        .textFieldStyle(.roundedBorder)
                    Text("Token is never persisted; it's submitted to the review item and used once at approval time.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
            }

            if let err = submitError {
                Text(err)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .card(padding: Spacing.md)
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel", action: onDismiss)
                .keyboardShortcut(.cancelAction)
            Button(submitting ? "Submitting…" : "Submit for review") {
                Task { await submit() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(submitting || result == nil || selectedRepo.isEmpty || (openPR && (ghRepo.isEmpty || ghToken.isEmpty)))
        }
        .padding(Spacing.lg)
    }

    private func runGeneration() async {
        generating = true
        generationError = nil
        defer { generating = false }
        do {
            result = try await api.generateCode(taskId: task.id, language: language)
        } catch {
            generationError = error.localizedDescription
        }
    }

    private func loadAllowedRepos() async {
        do {
            allowedRepos = try await api.listUserRepos()
            if selectedRepo.isEmpty, let first = allowedRepos.first {
                selectedRepo = first.path
            }
        } catch {
            // Non-fatal; the user sees the empty-state in targetBlock.
        }
    }

    private func submit() async {
        guard let r = result else { return }
        submitting = true
        submitError = nil
        defer { submitting = false }
        let pr: LlmIdeAPIClient.CodegenApplySubmitRequest.CodegenApplyPayload.PROptions? =
            openPR ? .init(ghRepo: ghRepo.trimmingCharacters(in: .whitespacesAndNewlines),
                           ghToken: ghToken,
                           baseBranch: baseBranch.isEmpty ? nil : baseBranch)
                   : nil
        do {
            let item = try await api.submitCodegenForReview(
                planId: plan.id,
                taskId: task.id,
                taskTitle: task.title,
                repoPath: selectedRepo,
                summary: r.summary,
                files: r.files,
                tests: r.tests,
                pr: pr,
            )
            onSubmitted(item)
        } catch {
            submitError = error.localizedDescription
        }
    }
}
