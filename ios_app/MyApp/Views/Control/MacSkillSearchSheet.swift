import SwiftUI
import SharedProtocol

/// Search Mac agent skills and attach `/skill` refs for Explore chat.
struct MacSkillSearchSheet: View {
    @EnvironmentObject var explorerStore: ExplorerChatStore
    @Binding var pendingSkills: [ExploreSkillRef]
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
            .navigationTitle("Mac skills")
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
        HStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(DesignSystem.Colors.textTertiary)
            TextField("Search skills (e.g. brainstorming)", text: $query)
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
    }

    @ViewBuilder
    private var resultsList: some View {
        if explorerStore.isSearchingSkills {
            ProgressView("Loading Mac skills…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = explorerStore.skillSearchError {
            emptyState(icon: "exclamationmark.triangle", title: err)
        } else if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            emptyState(
                icon: "sparkles",
                title: "Run Mac agent skills from iPhone",
                subtitle: "Search the same skill library as the Mac Explorer. Skills execute on your Mac with full workspace context."
            )
        } else if explorerStore.skillMatches.isEmpty {
            emptyState(icon: "text.magnifyingglass", title: "No skills found", subtitle: "Try another name.")
        } else {
            List(explorerStore.skillMatches) { entry in
                resultRow(entry)
            }
            .listStyle(.plain)
        }
    }

    private func resultRow(_ entry: ExploreSkillEntry) -> some View {
        let ref = skillRef(from: entry)
        let alreadyAdded = pendingSkills.contains { $0.id == ref.id }
        return HStack(alignment: .top, spacing: DesignSystem.Spacing.sm) {
            Image(systemName: icon(for: entry.kind))
                .foregroundColor(DesignSystem.Colors.primary)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(DesignSystem.Typography.bodyFont.weight(.medium))
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                Text(entry.description)
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Button(alreadyAdded ? "Added" : "/skill") {
                addSkill(ref)
            }
            .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
            .foregroundColor(alreadyAdded ? DesignSystem.Colors.textTertiary : DesignSystem.Colors.primary)
            .disabled(alreadyAdded)
        }
        .padding(.vertical, 4)
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "library": return "books.vertical.fill"
        case "subagent": return "person.2.fill"
        default: return "sparkles"
        }
    }

    private func skillRef(from entry: ExploreSkillEntry) -> ExploreSkillRef {
        let kind = entry.kind == "library" ? "library" : "directive"
        return ExploreSkillRef(id: entry.id, name: entry.name, kind: kind, directive: entry.directive)
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
        guard !trimmed.isEmpty else {
            explorerStore.skillMatches = []
            explorerStore.skillSearchError = nil
            explorerStore.isSearchingSkills = false
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { runSearch(trimmed) }
        }
    }

    private func runSearch(_ text: String) {
        explorerStore.searchSkills(text)
    }

    private func addSkill(_ ref: ExploreSkillRef) {
        guard !pendingSkills.contains(where: { $0.id == ref.id }) else { return }
        pendingSkills.append(ref)
        haptic(.light)
    }
}
