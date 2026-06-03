import SwiftUI

/// One row inside the session-picker popover in CodeAssistantPanel.
/// Shows title + relative timestamp; reveals a trash button on hover.
///
/// Module-internal (was file-private on CodeAssistantPanel.swift)
/// after extraction. Only the panel's session popover uses this — no
/// reason to expose it across modules.
struct SessionRow: View {
    let session: ChatSession
    let isActive: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var hovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 8) {
                Text(session.title.isEmpty ? "New chat" : session.title)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .foregroundStyle(theme.current.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                if hovering {
                    Button(action: onDelete) {
                        Image(systemName: "trash")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.current.danger.opacity(0.85))
                            .padding(4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Delete this chat")
                } else {
                    Text(Self.relativeLabel(for: session.lastUsedAt))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isActive ? theme.current.accent.opacity(0.10) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    /// Cheap "Today / Yesterday / 3d ago / Mar 5" stamp.
    private static func relativeLabel(for date: Date) -> String {
        let cal = Calendar.current
        let now = Date()
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: date, to: now).day ?? 0
        if days < 7 { return "\(days)d ago" }
        return AppDateFormatter.monthDay(date)
    }
}
