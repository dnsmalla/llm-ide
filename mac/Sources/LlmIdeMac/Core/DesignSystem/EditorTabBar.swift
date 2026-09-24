import SwiftUI

// MARK: - EditorTabBar

/// Horizontal editor tab strip shared by Review Code, the Explorer, and Search.
/// Operates purely on the two bindings: closing a tab removes it and
/// re-selects a neighbor so the caller never has to special-case the
/// close behavior. A tab whose file has unsaved edits (`EditorDraftStore`)
/// shows a dot and asks before it is closed — closing used to discard the
/// edits silently, because the editor's buffer lived in the view the close
/// destroyed.
struct EditorTabBar: View {
    @Binding var tabs: [URL]
    @Binding var activeTab: URL?

    @ObservedObject private var drafts = EditorDraftStore.shared
    @State private var pendingClose: URL?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(tabs, id: \.self) { url in
                    EditorTab(
                        url: url,
                        isActive: activeTab == url,
                        isDirty: drafts.hasDraft(url),
                        onSelect: { activeTab = url },
                        onClose: { requestClose(url) }
                    )
                }
            }
        }
        .frame(height: 35)
        .background(Color(NSColor.windowBackgroundColor))
        .confirmationDialog(
            "Close “\(pendingClose?.lastPathComponent ?? "")” without saving?",
            isPresented: Binding(get: { pendingClose != nil }, set: { if !$0 { pendingClose = nil } }),
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive) {
                if let url = pendingClose {
                    drafts.discard(url)
                    close(url)
                }
                pendingClose = nil
            }
            Button("Cancel", role: .cancel) { pendingClose = nil }
        } message: {
            Text("This file has unsaved changes. Cancel and press ⌘S to keep them.")
        }
    }

    private func requestClose(_ url: URL) {
        if drafts.hasDraft(url) {
            pendingClose = url
        } else {
            close(url)
        }
    }

    private func close(_ url: URL) {
        guard let idx = tabs.firstIndex(of: url) else { return }
        tabs.remove(at: idx)
        if activeTab == url {
            if tabs.isEmpty { activeTab = nil }
            else { activeTab = tabs[min(idx, tabs.count - 1)] }
        }
    }
}

// MARK: - EditorTab

private struct EditorTab: View {
    let url: URL
    let isActive: Bool
    let isDirty: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    @State private var isHovered = false
    @State private var closeHovered = false
    @EnvironmentObject private var theme: ThemeStore

    private var ext: String { url.pathExtension.lowercased() }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onSelect) {
                HStack(spacing: 5) {
                    Image(systemName: FileIconKit.icon(for: ext))
                        .font(.system(size: 11))
                        .foregroundStyle(FileIconKit.color(for: ext))
                        .frame(width: 14)
                    Text(url.lastPathComponent)
                        .font(Typography.filename)
                        .foregroundStyle(isActive ? .primary : .secondary)
                        .lineLimit(1)
                    if isDirty {
                        Circle()
                            .fill(theme.current.accent)
                            .frame(width: 6, height: 6)
                            .help("Unsaved changes")
                            .accessibilityLabel("Unsaved changes")
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, 6)
                .frame(height: 35)
            }
            .buttonStyle(.plain)

            // Close button — always reserved; visible on hover or when active
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(closeHovered ? .primary : .secondary)
                    .frame(width: 16, height: 16)
                    .background(
                        closeHovered
                            ? Color(.separatorColor).opacity(0.5)
                            : Color.clear,
                        in: RoundedRectangle(cornerRadius: 3)
                    )
                    .opacity(isHovered || isActive ? 1 : 0)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 6)
            .onHover { closeHovered = $0 }

            // Right divider
            Divider().frame(height: 18)
        }
        .background(
            isActive
                ? Color(.textBackgroundColor)
                : (isHovered ? Color(.separatorColor).opacity(0.15) : Color.clear)
        )
        .overlay(alignment: .bottom) {
            if isActive {
                Rectangle()
                    .fill(theme.current.accent)
                    .frame(height: 2)
            }
        }
        .onHover { isHovered = $0 }
        .animation(.easeInOut(duration: 0.1), value: isHovered)
    }
}
