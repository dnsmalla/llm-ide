// Compose sheet shown when the user clicks "Report this" on an
// assistant turn in CodeAssistantPanel. Pre-fills the prompt and
// response from the chat history; user adds notes + severity + tags
// and submits, which writes a markdown file under
// <repo>/system/faults/.
//
// The sheet is purely a UI concern. The data model (FaultReport) and
// the persistence path (MemoryStore.writeFault) live in CodeGraph/.

import SwiftUI

struct ReportFaultSheet: View {
    /// Prefilled prompt the agent was asked. Read-only — if the user
    /// wants to amend context, they put it in the notes field.
    let prompt: String
    /// Prefilled agent response. Editable in the sheet so the user can
    /// strip irrelevant chrome before saving.
    @State var response: String
    /// Active repo root. The sheet writes into
    /// `<repoRoot>/system/faults/`. Required — caller must
    /// have confirmed a repo is selected before presenting the sheet.
    let repoRoot: URL
    /// `AICliTool.rawValue` of the agent that produced the response.
    let agent: String

    var onSubmitted: (URL) -> Void
    var onDismiss: () -> Void
    /// Optional: when supplied, the sheet shows a "Also file as issue"
    /// toggle. After the local markdown save succeeds, if the toggle is
    /// on we call this closure with the saved FaultReport. Returning the
    /// new issue's web URL lets us surface a clickable confirmation.
    /// A nil return means the closure decided not to file (no-op).
    var onFileIssue: ((FaultReport) async throws -> URL?)?
    /// Display name of the issue tracker (e.g. "meet-notes (GitLab)").
    /// Used as the toggle's label. Required when `onFileIssue` is set.
    var fileIssueTargetLabel: String = ""

    @EnvironmentObject var theme: ThemeStore

    @State private var notes: String = ""
    @State private var severity: FaultSeverity = .major
    @State private var tagsField: String = ""
    @State private var submitting = false
    @State private var submitError: String?
    @State private var fileAsIssue: Bool = false
    @State private var filedIssueURL: URL?

    @EnvironmentObject private var config: AppConfig
    private var store: MemoryStore { config.memoryStore }

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("Report a fault").font(Typography.title).foregroundStyle(t.text)
                Spacer()
                Picker("", selection: $severity) {
                    ForEach(FaultSeverity.allCases) { s in
                        Text(s.displayName).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Prompt").font(Typography.caption).foregroundStyle(t.textMuted)
                ScrollView {
                    Text(prompt)
                        .font(Typography.body).foregroundStyle(t.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 80)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Response (editable)").font(Typography.caption).foregroundStyle(t.textMuted)
                TextEditor(text: $response)
                    .font(Typography.body)
                    .frame(minHeight: 120, maxHeight: 200)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("What went wrong").font(Typography.caption).foregroundStyle(t.textMuted)
                TextEditor(text: $notes)
                    .font(Typography.body)
                    .frame(minHeight: 80, maxHeight: 160)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            }

            HStack(spacing: Spacing.md) {
                Text("Tags").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("comma or space separated", text: $tagsField)
                    .textFieldStyle(.roundedBorder)
                    .font(Typography.body)
            }

            if onFileIssue != nil {
                Toggle(isOn: $fileAsIssue) {
                    Text("Also file as issue on \(fileIssueTargetLabel)")
                        .font(Typography.body)
                        .foregroundStyle(t.text)
                }
                .toggleStyle(.checkbox)
            }

            if let url = filedIssueURL {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(t.accent)
                    Text("Filed: ")
                    Link(url.absoluteString, destination: url)
                        .lineLimit(1).truncationMode(.middle)
                }
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
            }

            if let err = submitError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(3).truncationMode(.tail)
            }

            HStack {
                Spacer()
                Button("Cancel") { onDismiss() }
                    .buttonStyle(.bordered)
                    .disabled(submitting)
                Button(submitting ? "Saving…" : "Save report") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(submitting || notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(Spacing.lg)
        .frame(minWidth: 600, idealWidth: 680, minHeight: 520)
    }

    // MARK: - Submit

    private func submit() async {
        submitting = true; submitError = nil
        defer { submitting = false }
        let tags = tagsField
            .split(whereSeparator: { $0.isWhitespace || $0 == "," })
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let fault = FaultReport(
            prompt: prompt,
            response: response,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines),
            severity: severity,
            reportedAt: Date(),
            gitHead: GitHeadReader.shortHead(at: repoRoot),
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            agent: agent,
            status: .open,
            tags: tags
        )
        do {
            let url = try store.writeFault(at: repoRoot, fault)
            // If the user opted in, also create an upstream issue.
            // Local save is the source of truth: any upstream failure is
            // reported but does NOT undo the local file.
            if fileAsIssue, let filer = onFileIssue {
                do {
                    if let issueURL = try await filer(fault) {
                        filedIssueURL = issueURL
                    }
                } catch {
                    submitError = "Saved locally, but couldn't file as issue: \(error.localizedDescription)"
                    return  // keep sheet open so the user sees the link area & error
                }
            }
            onSubmitted(url)
        } catch {
            submitError = "Couldn't save fault report: \(error.localizedDescription)"
        }
    }
}

/// Tiny utility — read `<repo>/.git/HEAD` and resolve to a short SHA.
/// Returns nil on any I/O / format issue; the caller treats nil as
/// "no git context available".
enum GitHeadReader {
    static func shortHead(at repo: URL) -> String? {
        let headURL = repo.appendingPathComponent(".git/HEAD")
        guard let head = try? String(contentsOf: headURL, encoding: .utf8) else { return nil }
        let trimmed = head.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("ref: ") {
            // Detached symbolic ref — read the resolved file.
            let ref = String(trimmed.dropFirst("ref: ".count))
            let refURL = repo.appendingPathComponent(".git/").appendingPathComponent(ref)
            guard let sha = try? String(contentsOf: refURL, encoding: .utf8) else { return nil }
            return String(sha.trimmingCharacters(in: .whitespacesAndNewlines).prefix(10))
        }
        // Detached HEAD — the file IS the SHA.
        return String(trimmed.prefix(10))
    }
}
