import SwiftUI

/// Dropdown of "/" command/skill or "@" file candidates, rendered inline above
/// the Code Assistant input. Selection lives in the controller (keyboard nav
/// from the text view); a row tap accepts directly.
///
/// "/" rows are grouped under section headers (Commands / Skills / Subagents /
/// Skill Library / Hooks / MCP Servers) the way Claude Code's own menu is.
/// The controller computes `headers` in the same pass that orders `items`, so
/// this view only renders — it never re-derives the grouping, and never
/// indexes the live published array from inside a lazily-materialized row
/// (the local `items` snapshot below is what every closure captures).
struct CompletionMenu: View {
    @ObservedObject var controller: CompletionController
    @EnvironmentObject var theme: ThemeStore
    /// Called when a row is tapped (controller.selected is set first).
    var onAccept: () -> Void

    var body: some View {
        // Snapshot once per body evaluation; row closures capture this local
        // array, so a background catalog refresh shrinking `controller.items`
        // can't out-of-range a deferred lazy row.
        let items = controller.items
        let headers = controller.headers
        ScrollViewReader { proxy in
            ScrollView {
                // Lazy: the "/" menu is deliberately comprehensive (commands +
                // skills + hooks + MCP can run to hundreds of rows). ForEach
                // identity is the Int index so `proxy.scrollTo(idx)` resolves
                // even for rows the lazy container hasn't materialized yet —
                // an explicit `.id()` inside lazy content only registers once
                // the row exists, which broke keyboard scrolling past the fold.
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(items.indices, id: \.self) { index in
                        if let title = headers[index] {
                            SectionLabel(title, size: 9)
                                .padding(.horizontal, 8)
                                .padding(.top, 7)
                                .padding(.bottom, 3)
                        }
                        row(items[index], isSelected: index == controller.selected)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                controller.selected = index
                                onAccept()
                            }
                    }
                }
                .padding(4)
            }
            .frame(maxHeight: 220)
            .onChange(of: controller.selected) { _, idx in
                withAnimation(.linear(duration: 0.08)) { proxy.scrollTo(idx, anchor: .center) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.current.surface)
        .overlay(RoundedRectangle(cornerRadius: 8)
            .strokeBorder(theme.current.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
    }

    private func row(_ item: CompletionController.Item, isSelected: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon(item.kind))
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
                .frame(width: 14)
            Text(item.label)
                .font(.system(size: 12, weight: .medium, design: item.kind == .file ? .monospaced : .default))
                .foregroundStyle(theme.current.text)
                .lineLimit(1)
            if !item.detail.isEmpty {
                Text(item.detail)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
                    .truncationMode(item.kind == .file ? .head : .tail)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(isSelected ? theme.current.accent.opacity(0.18) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 5))
    }

    private func icon(_ kind: CompletionController.Kind) -> String {
        switch kind {
        case .command:      return "terminal"
        case .skill:        return "sparkles"
        case .subagent:     return "person.2"
        case .librarySkill: return "books.vertical"
        case .hook:         return "bolt"
        case .mcpServer:    return "server.rack"
        case .file:         return "doc.text"
        }
    }
}
