import SwiftUI

/// Sidebar row for a registered LLM source. Unlike `PluginLibraryRow`
/// (enable toggle lives only in the detail pane), the enable toggle is
/// INLINE here — per the design doc, since toggling a source is the single
/// most common action (it directly gates what shows up in the chat "/" menu).
struct LlmSourceRow: View {
    let source: LlmIdeAPIClient.LlmSourceInfo
    let onToggle: (Bool) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "books.vertical.fill")
                .foregroundStyle(source.enabled ? Color.accentColor : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(source.name).font(.callout).lineLimit(1)
                    originBadge
                    if !source.installed {
                        Text("not installed")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15))
                            .cornerRadius(3)
                    }
                }
                Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Toggle("", isOn: Binding(get: { source.enabled }, set: onToggle))
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private var originBadge: some View {
        Text(origin.label)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(origin.color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(origin.color.opacity(0.15))
            .clipShape(Capsule())
    }

    /// Origin label/color kept as a plain switch with a `default` case
    /// (not an exhaustive Swift enum on the wire type) — the server can add
    /// an origin (e.g. "marketplace", phase 2) without a client rebuild
    /// breaking decode; only the badge falls back to a generic look.
    private var origin: (label: String, color: Color) {
        switch source.origin {
        case "builtin": return ("builtin", .secondary)
        case "git":     return ("git", .blue)
        case "local":   return ("local", .green)
        default:        return (source.origin, .secondary)
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if source.skillCount > 0 { parts.append("\(source.skillCount) skill\(source.skillCount == 1 ? "" : "s")") }
        if source.agentCount > 0 { parts.append("\(source.agentCount) agent\(source.agentCount == 1 ? "" : "s")") }
        if source.hookCount > 0 { parts.append("\(source.hookCount) hook\(source.hookCount == 1 ? "" : "s")") }
        if let v = source.version, !v.isEmpty { parts.append("v\(v)") }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }
}
