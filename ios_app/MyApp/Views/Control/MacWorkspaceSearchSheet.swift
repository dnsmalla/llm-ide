import SwiftUI
import SharedProtocol

/// Search the paired Mac workspace by filename and attach `@file` / `@folder` refs.
struct MacWorkspaceSearchSheet: View {
    @EnvironmentObject var explorerStore: ExplorerChatStore
    @Binding var pendingRefs: [ExploreWorkspaceRef]
    var onDismiss: () -> Void

    @State private var query: String = ""
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var isQueryFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                searchField
                Divider()
                resultsList
            }
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .navigationTitle("Mac workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { onDismiss() }
                }
            }
            .onAppear { isQueryFocused = true }
            .onChange(of: query) { newValue in
                scheduleSearch(newValue)
            }
        }
    }

    private var searchField: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                TextField("Search by filename (e.g. config.json)", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($isQueryFocused)
                    .submitLabel(.search)
                    .onSubmit { runSearch(query) }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, DesignSystem.Spacing.sm)
            .background(DesignSystem.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(DesignSystem.Spacing.md)

            if let root = explorerStore.workspaceSearchRoot {
                Text("Mac root: \(root)")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .padding(.horizontal, DesignSystem.Spacing.md)
            }
        }
    }

    @ViewBuilder
    private var resultsList: some View {
        if explorerStore.isSearchingWorkspace {
            ProgressView("Searching Mac…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = explorerStore.workspaceSearchError {
            emptyState(icon: "exclamationmark.triangle", title: err)
        } else if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 {
            emptyState(
                icon: "macbook",
                title: "Find files on your Mac",
                subtitle: "Type at least 2 characters. Results come from the Mac project workspace, not your iPhone."
            )
        } else if explorerStore.workspaceMatches.isEmpty {
            emptyState(icon: "doc.text.magnifyingglass", title: "No matches", subtitle: "Try another filename or folder name.")
        } else {
            List(explorerStore.workspaceMatches) { entry in
                resultRow(entry)
            }
            .listStyle(.plain)
        }
    }

    private func resultRow(_ entry: ExploreWorkspaceEntry) -> some View {
        let kind = entry.isDirectory ? "folder" : "file"
        let alreadyAdded = pendingRefs.contains { $0.path == entry.path && $0.kind == kind }
        return HStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: entry.isDirectory ? "folder.fill" : "doc.text.fill")
                .foregroundColor(DesignSystem.Colors.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(DesignSystem.Typography.bodyFont.weight(.medium))
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                Text(entry.path)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Button(alreadyAdded ? "Added" : (entry.isDirectory ? "@folder" : "@file")) {
                addRef(entry)
            }
            .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
            .foregroundColor(alreadyAdded ? DesignSystem.Colors.textTertiary : DesignSystem.Colors.primary)
            .disabled(alreadyAdded)
        }
        .padding(.vertical, 4)
    }

    private func emptyState(icon: String, title: String, subtitle: String? = nil) -> some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 34))
                .foregroundColor(DesignSystem.Colors.textTertiary)
            Text(title)
                .font(DesignSystem.Typography.calloutFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
                .multilineTextAlignment(.center)
            if let subtitle {
                Text(subtitle)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, DesignSystem.Spacing.lg)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func scheduleSearch(_ text: String) {
        searchTask?.cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            explorerStore.workspaceMatches = []
            explorerStore.workspaceSearchError = nil
            explorerStore.isSearchingWorkspace = false
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { runSearch(trimmed) }
        }
    }

    private func runSearch(_ text: String) {
        explorerStore.searchWorkspace(text)
    }

    private func addRef(_ entry: ExploreWorkspaceEntry) {
        let kind = entry.isDirectory ? "folder" : "file"
        let ref = ExploreWorkspaceRef(path: entry.path, kind: kind)
        guard !pendingRefs.contains(where: { $0.id == ref.id }) else { return }
        pendingRefs.append(ref)
        haptic(.light)
    }
}
