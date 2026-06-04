import SwiftUI

/// Cmd-P quick switcher HUD. Modal sheet with a text field at the
/// top and a filtered list of recent projects below. Enter or click
/// switches; Esc dismisses.
struct QuickSwitcherSheet: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore
    @Binding var isPresented: Bool
    @State private var filter: String = ""
    @State private var errorMessage: String?

    var filtered: [ProjectStore.RecentEntry] {
        guard !filter.isEmpty else { return projectStore.recents }
        let needle = filter.lowercased()
        return projectStore.recents.filter {
            $0.displayName.lowercased().contains(needle) ||
            $0.path.lowercased().contains(needle)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("Switch project — type to filter", text: $filter)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .padding(Spacing.md)
                // Enter on a non-empty filter (or with default ordering)
                // activates the first matching recent. Otherwise the
                // sheet only responded to mouse clicks, which is a
                // dead-end for keyboard-first users.
                .onSubmit { activateFirstMatch() }
            Divider()
            if projectStore.recents.isEmpty {
                Text("No recent projects yet. Open one via the sidebar chip.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.md)
            } else if filtered.isEmpty {
                Text("No matches.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.md)
            } else {
                ScrollView {
                    RecentProjectsList(entries: filtered) { entry in
                        activate(entry)
                    }
                    .padding(Spacing.md)
                }
                .frame(maxHeight: 320)
            }
            if let msg = errorMessage {
                Divider()
                Text(msg)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .padding(Spacing.md)
            }
        }
        .frame(minWidth: 540, maxWidth: 600)
        .background(theme.current.surface)
        .onExitCommand { isPresented = false }
        // Reset transient state when the sheet appears (re-open after
        // dismiss) and whenever the user changes the filter — a stale
        // error from a previous switch attempt should not stick
        // around once they've started typing again.
        .onAppear { errorMessage = nil }
        .onChange(of: filter) { _, _ in errorMessage = nil }
    }

    private func activateFirstMatch() {
        guard let first = filtered.first else { return }
        activate(first)
    }

    private func activate(_ entry: ProjectStore.RecentEntry) {
        do {
            try projectStore.switchTo(recent: entry)
            isPresented = false
        } catch let err {
            errorMessage = err.localizedDescription
        }
    }
}
