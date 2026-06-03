import SwiftUI

/// Sidebar row for a single installed plugin. Shows enable state via
/// the icon colour so users can scan the list at a glance without
/// opening the detail pane.
struct PluginLibraryRow: View {
    let plugin: PluginInfo

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "puzzlepiece.extension.fill")
                .foregroundStyle(plugin.enabled ? Color.accentColor : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(plugin.displayName.isEmpty ? plugin.name : plugin.displayName)
                        .font(.callout)
                        .lineLimit(1)
                    if !plugin.enabled {
                        Text("off")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15))
                            .cornerRadius(3)
                    }
                    if plugin.name.hasPrefix("claude-") {
                        Text("Claude")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Color(red: 0.85, green: 0.55, blue: 0.25))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color(red: 0.85, green: 0.55, blue: 0.25).opacity(0.15))
                            .clipShape(Capsule())
                    }
                }
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        var parts: [String] = []
        if plugin.skillCount > 0 { parts.append("\(plugin.skillCount) skill\(plugin.skillCount == 1 ? "" : "s")") }
        if !plugin.commands.isEmpty { parts.append("\(plugin.commands.count) command\(plugin.commands.count == 1 ? "" : "s")") }
        if !plugin.subagents.isEmpty { parts.append("\(plugin.subagents.count) agent\(plugin.subagents.count == 1 ? "" : "s")") }
        return parts.isEmpty ? "v\(plugin.version)" : parts.joined(separator: " · ")
    }
}
