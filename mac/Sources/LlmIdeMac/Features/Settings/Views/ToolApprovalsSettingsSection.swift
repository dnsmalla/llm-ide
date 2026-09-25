import SwiftUI

/// App-scoped Settings card listing the "always allow" permission rules made
/// from the chat approval card — Claude Code's "don't ask again for …" —
/// grouped by project, with a per-row Revoke and a confirmed Revoke All.
///
/// A rule is per project and, for shell commands, per command prefix
/// (`npm test`), so a row reads as exactly what runs without asking and where.
/// Pre-v55 global grants (no longer honoured) are listed at the bottom so
/// nothing permitted is ever invisible.
///
/// Read + delete only; rows are written by the approval card, and every
/// mutation re-renders from the server's returned remainder.
struct ToolApprovalsSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore

    @State private var permissions = LlmIdeAPIClient.ToolPermissions()
    /// Whether the first load has finished. `loading` used to START true and
    /// `load()` bailed out while it was true, so the first load never ran and
    /// the card showed "Loading…" forever.
    @State private var loaded = false
    @State private var error: String?
    @State private var busy = false
    @State private var showRevokeAllConfirmation = false

    private var isEmpty: Bool { permissions.rules.isEmpty && permissions.legacy.isEmpty }

    /// Rules grouped by project, projects in name order.
    private var groups: [(project: String, rules: [LlmIdeAPIClient.ToolRule])] {
        Dictionary(grouping: permissions.rules, by: \.projectRoot)
            .map { ($0.key, $0.value) }
            .sorted { $0.project.localizedStandardCompare($1.project) == .orderedAscending }
    }

    var body: some View {
        SettingsSectionCard(icon: "hand.raised", title: "Tool permissions") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint(
                    "Commands and tools you chose \"Always allow\" for, per project. Revoking one doesn't block it — the assistant just asks you again. File edits allowed \"in this chat\" last only for that chat and aren't listed."
                )

                if !loaded {
                    HStack(spacing: Spacing.sm) {
                        ProgressView().controlSize(.small)
                        Text("Loading…")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                } else if isEmpty {
                    Text("Nothing is always allowed. Anything that needs approval asks you each time.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(groups, id: \.project) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            Label((group.project as NSString).lastPathComponent, systemImage: "folder")
                                .font(Typography.captionStrong)
                                .foregroundStyle(theme.current.textMuted)
                                .help(group.project)
                            ForEach(group.rules) { rule in ruleRow(rule) }
                        }
                    }
                    if !permissions.legacy.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Older grants (no longer used)")
                                .font(Typography.captionStrong)
                                .foregroundStyle(theme.current.textMuted)
                            ForEach(permissions.legacy) { legacyRow($0) }
                        }
                    }
                }

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
                    if !isEmpty {
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
        .confirmationDialog("Revoke every tool permission?", isPresented: $showRevokeAllConfirmation) {
            Button("Revoke All", role: .destructive) { Task { await revokeAll() } }
        } message: {
            Text("The assistant will ask for your approval again the next time. Nothing is blocked and no work is lost.")
        }
        .task { await load() }
    }

    /// "`npm test` commands" / "network access to `registry.npmjs.org`" / "deploy-app".
    static func ruleTitle(_ rule: LlmIdeAPIClient.ToolRule) -> String {
        rule.pattern.isEmpty
            ? ClaudeToolPresentation.approvalTitle(toolName: rule.toolName)
            : ClaudeToolPresentation.ruleSubject(toolName: rule.toolName, pattern: rule.pattern)
    }

    private func ruleRow(_ rule: LlmIdeAPIClient.ToolRule) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: ClaudeToolPresentation.approvalIcon(toolName: rule.toolName))
                .font(.system(size: 11))
                .foregroundStyle(theme.current.accent4)
            VStack(alignment: .leading, spacing: 1) {
                Text(LocalizedStringKey(Self.ruleTitle(rule)))
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Text("Allowed \(AppDateFormatter.absoluteMedium(rule.grantedAt))")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer(minLength: Spacing.sm)
            Button { Task { await revoke(rule) } } label: { Text("Revoke").font(Typography.caption) }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy)
        }
    }

    private func legacyRow(_ approval: LlmIdeAPIClient.ToolApproval) -> some View {
        HStack(spacing: Spacing.sm) {
            Text(ClaudeToolPresentation.approvalTitle(toolName: approval.toolName))
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            Spacer(minLength: Spacing.sm)
            Button { Task { await removeLegacy(approval.toolName) } } label: { Text("Remove").font(Typography.caption) }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy)
        }
    }

    // MARK: Data

    private func load() async {
        guard !busy else { return }
        busy = true; defer { busy = false; loaded = true }
        error = nil
        do { permissions = try await api.toolPermissions() }
        catch { self.error = "Couldn't load tool permissions." }
    }

    private func revoke(_ rule: LlmIdeAPIClient.ToolRule) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        error = nil
        do { permissions = try await api.revokeToolRule(rule) }
        catch { self.error = "Couldn't revoke it — it is still allowed." }
    }

    private func removeLegacy(_ toolName: String) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        error = nil
        do { permissions = try await api.revokeToolApproval(toolName: toolName) }
        catch { self.error = "Couldn't remove \(toolName)." }
    }

    private func revokeAll() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        error = nil
        do { permissions = try await api.revokeAllToolPermissions() }
        catch { self.error = "Couldn't revoke tool permissions — they are unchanged." }
    }
}
