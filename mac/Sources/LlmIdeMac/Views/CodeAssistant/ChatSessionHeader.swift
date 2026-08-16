import SwiftUI

extension CodeAssistantPanel {

    // MARK: - Header

    var header: some View {
        HStack(spacing: 10) {
            if !isVeryCompact {
                SectionLabel(isCompact ? "AI" : "Code Assistant", size: 12, tracking: 0.8)
                    .lineLimit(1)
            }
            // Session counter only when we have horizontal room to spare.
            if !isCompact, !engine.history.isEmpty || !attachmentState.attachments.isEmpty {
                Text("·")
                    .foregroundStyle(theme.current.textMuted.opacity(0.5))
                Text("\(engine.history.count) turn\(engine.history.count == 1 ? "" : "s")  \(attachmentState.attachments.count) file\(attachmentState.attachments.count == 1 ? "" : "s")")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            loopEngineeringButton
            sessionDropdownButton
            clearChatButton
        }
        .padding(.horizontal, isVeryCompact ? 6 : Spacing.md)
        .padding(.vertical, 8)
    }

    /// Cursor-style chat-list dropdown: shows the current session's
    /// title and opens a popover with recent sessions + "New chat".
    var sessionDropdownButton: some View {
        Button {
            // Refresh the list every time the popover opens so the
            // ordering reflects the latest `lastUsedAt`.
            engine.refreshSessions()
            sessionSearchQuery = ""
            showingSessionPicker.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 10, weight: .medium))
                if !isVeryCompact {
                    Text(currentSessionTitle)
                        .font(.system(size: 11))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .medium))
            }
            .padding(.horizontal, isVeryCompact ? 4 : 8)
            .padding(.vertical, 4)
            .foregroundStyle(theme.current.textMuted)
            .frame(maxWidth: isCompact ? 90 : 220, alignment: .trailing)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Switch chat session")
        .accessibilityLabel("Switch chat session")
        .popover(isPresented: $showingSessionPicker, arrowEdge: .top) {
            sessionPickerPopover
        }
    }

    var currentSessionTitle: String {
        guard let cur = UUID(uuidString: engine.currentSessionIDString),
              let s = engine.sessions.first(where: { $0.id == cur }) else {
            return "New chat"
        }
        return s.title.isEmpty ? "New chat" : s.title
    }

    /// Sessions shown in the popover: the 20 most recent by default, or —
    /// while actively searching — every session (across the full history,
    /// not just that recent window) whose title matches.
    var filteredSessions: [ChatSession] {
        let q = sessionSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return Array(engine.sessions.prefix(20)) }
        return engine.sessions.filter { ($0.title.isEmpty ? "New chat" : $0.title).lowercased().contains(q) }
    }

    var sessionPickerPopover: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
                TextField("Search chats", text: $sessionSearchQuery)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            Button {
                showingSessionPicker = false
                engine.createNewSession()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .medium))
                    Text("New chat")
                        .font(.system(size: 12, weight: .medium))
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.current.text)

            Divider()

            let shown = filteredSessions
            if shown.isEmpty {
                Text(engine.sessions.isEmpty ? "No saved chats yet." : "No chats match “\(sessionSearchQuery)”.")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(shown) { session in
                            SessionRow(
                                session: session,
                                isActive: session.id.uuidString == engine.currentSessionIDString,
                                onSelect: {
                                    showingSessionPicker = false
                                    engine.switchSession(to: session.id)
                                },
                                onDelete: {
                                    Task { await engine.deleteSession(session.id) }
                                },
                                onRename: { newTitle in
                                    engine.renameSession(session.id, to: newTitle)
                                }
                            )
                            .environmentObject(theme)
                        }
                    }
                }
                .frame(maxHeight: 320)
            }
        }
        .frame(width: 320)
    }

    /// Header button: delete the current chat (mints a fresh empty one if
    /// it was the last remaining session for this scope).
    var clearChatButton: some View {
        Button {
            Task { await engine.clearCurrentChat() }
        } label: {
            Image(systemName: "trash")
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .foregroundStyle(theme.current.textMuted)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Delete current chat")
        .accessibilityLabel("Delete current chat")
        .disabled(engine.history.isEmpty && engine.sessions.count <= 1)
    }


}
