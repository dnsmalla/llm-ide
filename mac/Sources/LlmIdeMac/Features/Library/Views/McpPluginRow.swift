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
            // Unconsented reads as a labelled call to action, not a bare
            // glyph: consent is the gate a new server is always stuck behind,
            // and an icon-only shield left users toggling the (inert) switch
            // instead. Consented collapses back to the compact check.
            Button {
                onToggleConsent(!plugin.consented)
            } label: {
                if plugin.consented {
                    Image(systemName: "checkmark.shield.fill").foregroundStyle(Color.green)
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: "shield")
                        Text("Consent").font(.caption2)
                    }
                    .foregroundStyle(Color.orange)
                }
            }
            .buttonStyle(.plain)
            .help(plugin.consented ? "Consented — click to revoke" : "Not consented — click to consent. Until you do, this server never reaches the agent.")
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

    /// A hosted server has no command to show — its URL is the identity.
    /// `endpointSummary` picks the right one for the transport. A server that
    /// is not effectively active leads with the gate blocking it (same
    /// "<status> · <endpoint>" form the completion menu uses), so the row says
    /// WHY it does nothing instead of only what it would run.
    private var subtitle: String {
        plugin.statusSummary == "enabled"
            ? plugin.endpointSummary
            : "\(plugin.statusSummary) · \(plugin.endpointSummary)"
    }
}
