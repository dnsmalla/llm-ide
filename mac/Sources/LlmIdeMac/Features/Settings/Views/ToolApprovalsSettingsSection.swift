import SwiftUI

/// App-scoped Settings card listing the standing "Always Allow" tool grants
/// made from the chat approval card, with a per-row Revoke and a confirmed
/// Revoke All.
///
/// This card exists because the grant used to be a one-way door: it is stored
/// per-(user, tool) in `tool_approvals` and outlives the chat, the project and
/// the app, so without a list there was no surface anywhere that even showed
/// what had been permanently permitted — let alone withdrew it. Not
/// project-scoped (the grant isn't either), which is why it sits in the App
/// group rather than next to the project cards.
///
/// Mirrors `ProjectMemoryView`'s shape: read + delete only, rows are written
/// elsewhere (by the approval card), and every mutation re-renders from the
/// server's returned remainder rather than mutating local state optimistically.
struct ToolApprovalsSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore

    @State private var approvals: [LlmIdeAPIClient.ToolApproval] = []
    @State private var loading = true
    @State private var error: String?
    @State private var busy = false
    @State private var showRevokeAllConfirmation = false

    var body: some View {
        SettingsSectionCard(icon: "hand.raised", title: "Tool permissions") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint(
                    "Tools you chose \"Always Allow\" for in chat. Revoking one doesn't block the tool — the assistant can still use it, it just has to ask you for approval again."
                )

                if loading {
                    HStack(spacing: Spacing.sm) {
                        ProgressView().controlSize(.small)
                        Text("Loading…")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                } else if approvals.isEmpty {
                    // Deliberately not styled as a problem: no standing grants
                    // is the default and the safest state, not an error.
                    Text("No tools have been permanently allowed. Every tool that needs approval will ask you each time.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(approvals) { approval in
                        approvalRow(approval)
                    }
                }

                // Failures render as their own row and the list is left
                // untouched, so a revoke that didn't land never looks like it
                // did — the tool stays visible until the server drops it.
                if let error {
                    HStack(spacing: Spacing.xs) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.current.danger)
                        Text(error)
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Divider().padding(.vertical, 2)
                HStack {
                    Button("Refresh") { Task { await load() } }
                        .controlSize(.small)
                        .disabled(busy)
                    Spacer()
                    if !approvals.isEmpty {
                        Button(role: .destructive) { showRevokeAllConfirmation = true } label: {
                            Text("Revoke all").font(Typography.caption)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(busy)
                    }
                }
                .padding(.top, 2)
            }
        }
        .confirmationDialog(
            "Revoke all standing tool approvals?",
            isPresented: $showRevokeAllConfirmation
        ) {
            Button("Revoke All", role: .destructive) { Task { await revokeAll() } }
        } message: {
            Text("All \(approvals.count) always-allowed tool\(approvals.count == 1 ? "" : "s") will ask for your approval again the next time the assistant uses them. Nothing is blocked and no work is lost.")
        }
        .task { await load() }
    }

    private func approvalRow(_ approval: LlmIdeAPIClient.ToolApproval) -> some View {
        HStack(spacing: Spacing.sm) {
            // Same icon/wording table the approval card uses, so a row here
            // reads as the grant the user made there.
            Image(systemName: ClaudeToolPresentation.approvalIcon(toolName: approval.toolName))
                .font(.system(size: 11))
                .foregroundStyle(theme.current.accent4)
            VStack(alignment: .leading, spacing: 1) {
                Text(ClaudeToolPresentation.approvalTitle(toolName: approval.toolName))
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Text("Allowed \(AppDateFormatter.absoluteMedium(approval.grantedAt))")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer(minLength: Spacing.sm)
            Button { Task { await revoke(approval.toolName) } } label: {
                Text("Revoke").font(Typography.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(busy)
            .help("Ask for approval again before running \(approval.toolName)")
        }
    }

    // MARK: Data

    private func load() async {
        // Inside the same interlock as revoke/revokeAll, which `load` sat
        // outside of. Two entry points can fire it (the `.task` on appear and
        // the Refresh button), so overlapping loads could both assign
        // `approvals` — last to finish wins, which after a revoke means the
        // stale pre-revoke list can land on top of the fresh one.
        guard !busy, !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { approvals = try await api.toolApprovals() }
        catch { self.error = "Couldn't load tool permissions." }
    }

    private func revoke(_ toolName: String) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        error = nil
        do { approvals = try await api.revokeToolApproval(toolName: toolName) }
        catch { self.error = "Couldn't revoke \(toolName) — it is still always-allowed." }
    }

    private func revokeAll() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        error = nil
        do { approvals = try await api.revokeAllToolApprovals() }
        catch { self.error = "Couldn't revoke tool permissions — they are unchanged." }
    }
}
