import SwiftUI

/// One row inside the session-picker popover in CodeAssistantPanel.
/// Shows title + relative timestamp; reveals rename/delete buttons on
/// hover. Renaming happens inline (no separate sheet) — matches the
/// hover-reveal affordance already established here for delete.
struct SessionRow: View {
    let session: ChatSession
    let isActive: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void
    let onRename: (String) -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var hovering = false
    @State private var isEditing = false
    @State private var editedTitle = ""
    @FocusState private var fieldFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            if isEditing {
                TextField("Chat name", text: $editedTitle, onCommit: commitRename)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .foregroundStyle(theme.current.text)
                    .focused($fieldFocused)
                    .onExitCommand { isEditing = false } // Escape discards
            } else {
                Text(session.title.isEmpty ? "New chat" : session.title)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .foregroundStyle(theme.current.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 6)
            if isEditing {
                Button(action: commitRename) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.success)
                        .padding(4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Save name")
            } else if hovering {
                HStack(spacing: 2) {
                    Button(action: startEditing) {
                        Image(systemName: "pencil")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.current.textMuted)
                            .padding(4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Rename this chat")
                    Button(action: onDelete) {
                        Image(systemName: "trash")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.current.danger.opacity(0.85))
                            .padding(4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Delete this chat")
                }
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
        .onTapGesture { if !isEditing { onSelect() } }
        .onHover { hovering = $0 }
    }

    private func startEditing() {
        editedTitle = session.title.isEmpty ? "New chat" : session.title
        isEditing = true
        fieldFocused = true
    }

    private func commitRename() {
        isEditing = false
        let trimmed = editedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed != session.title { onRename(trimmed) }
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
