import SwiftUI

/// Viewer for the auto-captured project memory (chat-memory.md). Because
/// capture is automatic, the user needs to see and prune what's been learned.
/// Read + delete only — facts are written by the agent, not added by hand.
struct ProjectMemoryView: View {
    let api: LlmIdeAPIClient
    /// Candidate repo paths (the client's indexedRepos, "~/…"). The server
    /// resolves the first allow-listed one — the same file the agent captures
    /// into — and returns it as `resolvedRepo` for deletes. Empty = no project.
    let repos: [String]

    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    @State private var facts: [String] = []
    @State private var resolvedRepo: String?
    @State private var loading = true
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(theme.current.border)
            content
        }
        .frame(width: 460, height: 420)
        .background(theme.current.body)
        .task { await load() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "brain")
                .foregroundStyle(theme.current.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text("Project memory")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.text)
                Text("What the assistant has learned about this project")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer()
            if !facts.isEmpty {
                Button(role: .destructive) { Task { await clearAll() } } label: {
                    Text("Clear all").font(.system(size: 11))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy)
            }
            Button { dismiss() } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .foregroundStyle(theme.current.textMuted)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            centered { ProgressView().controlSize(.small) }
        } else if let error {
            centered {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.textMuted)
                    .multilineTextAlignment(.center)
            }
        } else if repos.isEmpty || resolvedRepo == nil {
            centered { emptyState("Open a project with an indexed repo to capture memory.") }
        } else if facts.isEmpty {
            centered { emptyState("Nothing remembered yet. The assistant will capture durable facts as you chat about this project.") }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(facts, id: \.self) { fact in
                        factRow(fact)
                        Divider().background(theme.current.border.opacity(0.5))
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func factRow(_ fact: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "circle.fill")
                .font(.system(size: 4))
                .foregroundStyle(theme.current.textMuted)
                .padding(.top, 7)
            Text(fact)
                .font(.system(size: 12))
                .foregroundStyle(theme.current.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button { Task { await remove(fact) } } label: {
                Image(systemName: "trash")
                    .font(.system(size: 10))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .help("Forget this")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
    }

    private func emptyState(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 12))
            .foregroundStyle(theme.current.textMuted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 30)
    }

    private func centered<V: View>(@ViewBuilder _ inner: () -> V) -> some View {
        VStack { Spacer(); inner(); Spacer() }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Data

    private func load() async {
        guard !repos.isEmpty else { loading = false; return }
        loading = true; error = nil
        do {
            let r = try await api.projectMemory(repos: repos)
            facts = r.facts
            resolvedRepo = r.repo
        } catch { self.error = "Couldn't load project memory." }
        loading = false
    }

    private func remove(_ fact: String) async {
        guard !busy, let repo = resolvedRepo else { return }
        busy = true; defer { busy = false }
        do { facts = try await api.deleteProjectMemoryFact(repo: repo, fact: fact) }
        catch { self.error = "Couldn't update project memory." }
    }

    private func clearAll() async {
        guard !busy, let repo = resolvedRepo else { return }
        busy = true; defer { busy = false }
        do { facts = try await api.clearProjectMemory(repo: repo) }
        catch { self.error = "Couldn't clear project memory." }
    }
}
