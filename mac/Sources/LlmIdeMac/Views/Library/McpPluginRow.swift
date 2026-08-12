import SwiftUI

/// Sidebar row for a registered MCP plugin. Two independent per-user gates
/// govern whether the Claude CLI's `--mcp-config` ever sees this server —
/// `consented` and `enabled` — so both surface inline, matching how
/// `LlmSourceRow` puts its single `enabled` toggle inline (the most common
/// action belongs in the list, not buried in the detail pane).
struct McpPluginRow: View {
    let plugin: LlmIdeAPIClient.McpPluginInfo
    let onToggleConsent: (Bool) -> Void
    let onToggleEnabled: (Bool) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.horizontal.circle.fill")
                .foregroundStyle(plugin.enabled && plugin.consented ? Color.accentColor : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(plugin.name).font(.callout).lineLimit(1)
                    sourceBadge
                }
                Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                onToggleConsent(!plugin.consented)
            } label: {
                Image(systemName: plugin.consented ? "checkmark.shield.fill" : "shield")
                    .foregroundStyle(plugin.consented ? Color.green : Color.secondary)
            }
            .buttonStyle(.plain)
            .help(plugin.consented ? "Consented — click to revoke" : "Not consented — click to consent")
            Toggle("", isOn: Binding(get: { plugin.enabled }, set: onToggleEnabled))
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .disabled(!plugin.consented)
                .help(plugin.consented ? "" : "Consent before enabling")
        }
        .padding(.vertical, 2)
    }

    private var sourceBadge: some View {
        Text(plugin.source == "claude" ? "claude" : "manual")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(plugin.source == "claude" ? Color.blue : Color.secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background((plugin.source == "claude" ? Color.blue : Color.secondary).opacity(0.15))
            .clipShape(Capsule())
    }

    private var subtitle: String {
        ([plugin.command] + plugin.args).joined(separator: " ")
    }
}
