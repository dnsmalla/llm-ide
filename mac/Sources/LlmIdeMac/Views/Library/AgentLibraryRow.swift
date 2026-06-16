import SwiftUI

/// Row variant enum so callers express intent declaratively.
enum AgentRowKind {
    /// Built-in, non-deletable core agent (lock icon).
    case builtin
    /// User-created persona (sparkle icon, optionally marked active).
    case persona(isActive: Bool)
    /// Plugin-contributed subagent (puzzle icon).
    case plugin
}

/// Sidebar row for any agent entry in the Library: built-in core
/// agents, user personas, or plugin-contributed subagents.
struct AgentLibraryRow: View {
    @EnvironmentObject private var theme: ThemeStore
    let title: String
    let subtitle: String?
    var kind: AgentRowKind = .persona(isActive: false)

    var body: some View {
        HStack(spacing: 8) {
            iconView
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(title)
                        .font(.callout)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    trailingBadge
                }
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Subviews

    @ViewBuilder
    private var iconView: some View {
        ZStack {
            Circle()
                .fill(iconColor.opacity(0.15))
                .frame(width: 28, height: 28)
            Image(systemName: iconName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(iconColor)
        }
    }

    @ViewBuilder
    private var trailingBadge: some View {
        switch kind {
        case .builtin:
            Image(systemName: "lock.fill")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        case .persona(let isActive) where isActive:
            Image(systemName: "star.fill")
                .font(.caption2)
                .foregroundStyle(theme.current.warning)
        case .plugin:
            Image(systemName: "puzzlepiece.extension.fill")
                .font(.caption2)
                .foregroundStyle(.teal.opacity(0.7))
        default:
            EmptyView()
        }
    }

    // MARK: - Helpers

    private var iconName: String {
        switch kind {
        case .builtin:           return "brain.head.profile"
        case .persona:           return "sparkle"
        case .plugin:            return "puzzlepiece.extension"
        }
    }

    private var iconColor: Color {
        switch kind {
        case .builtin:           return .blue
        case .persona(let a):    return a ? .purple : .purple.opacity(0.7)
        case .plugin:            return .teal
        }
    }
}
