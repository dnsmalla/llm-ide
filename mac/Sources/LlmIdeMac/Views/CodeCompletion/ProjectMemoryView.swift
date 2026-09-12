import SwiftUI

/// Viewer for the auto-captured memory: the project's (chat-memory.md) and,
/// when opened from a chat, that chat's own session memory (kb/session-
/// memory.mjs). Because capture is automatic, the user needs to see and
/// prune what's been learned. Read + delete only — facts are written by the
/// agent, not added by hand.
///
/// The session section is what makes session memory VISIBLE at all: it was
/// injected into prompts and deleted with the chat, but never shown, which
/// read as "session memory isn't used".
struct ProjectMemoryView: View {
    let api: LlmIdeAPIClient
    /// Candidate repo paths (the client's indexedRepos, "~/…"). The server
    /// resolves the first allow-listed one — the same file the agent captures
    /// into — and returns it as `resolvedRepo` for deletes. Empty = no project.
    let repos: [String]
    /// The open Explorer folder ("~/…"), if any. Lets memory resolve to the
    /// open project even when it isn't a formally-indexed repo.
    var workspaceRoot: String? = nil
    /// The chat this viewer was opened from (its stable session-store UUID),
    /// if any — the key session memory is stored under. Nil from surfaces
    /// with no chat.
    var sessionId: String? = nil

    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    @State private var facts: [String] = []
    /// This chat's session memory; empty when there is no chat or nothing
    /// captured yet.
    @State private var sessionFacts: [String] = []
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
                Text("Memory")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.text)
                Text("What the assistant has learned about this project — and in this chat")
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
        } else if resolvedRepo == nil && sessionFacts.isEmpty {
            centered { emptyState("Open a project folder (or index a repo) to capture memory.") }
        } else if facts.isEmpty && sessionFacts.isEmpty {
            centered { emptyState("Nothing remembered yet. The assistant will capture durable facts as you chat about this project.") }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !sessionFacts.isEmpty {
                        sectionHeader(
                            "This chat",
                            subtitle: "Decisions and state from this conversation — forgotten with the chat",
                            trailing: {
                                Button(role: .destructive) { Task { await forgetSession() } } label: {
                                    Text("Forget").font(.system(size: 11))
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .disabled(busy)
                                .help("Forget everything this chat's memory holds")
                            })
                        ForEach(sessionFacts, id: \.self) { fact in
                            sessionRow(fact)
                            Divider().background(theme.current.border.opacity(0.5))
                        }
                    }
                    if !facts.isEmpty {
                        if !sessionFacts.isEmpty {
                            sectionHeader("This project",
                                          subtitle: "Durable facts, recalled in every chat about this project",
                                          trailing: { EmptyView() })
                        }
                        ForEach(facts, id: \.self) { fact in
                            factRow(fact)
                            Divider().background(theme.current.border.opacity(0.5))
                        }
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func sectionHeader<T: View>(_ title: String, subtitle: String,
                                        @ViewBuilder trailing: () -> T) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer(minLength: 4)
            trailing()
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    /// A session fact: plain sentence, no per-row delete — session memory is
    /// forgotten together (there is no per-fact edit on the server), and the
    /// section header carries that action.
    private func sessionRow(_ fact: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "circle.fill")
                .font(.system(size: 4))
                .foregroundStyle(theme.current.accent)
                .padding(.top, 7)
            Text(fact)
                .font(.system(size: 12))
                .foregroundStyle(theme.current.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
    }

    private func factRow(_ fact: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "circle.fill")
                .font(.system(size: 4))
                .foregroundStyle(theme.current.textMuted)
                .padding(.top, 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.factText(fact))
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.text)
                    .fixedSize(horizontal: false, vertical: true)
                // A stored fact carries a trailing `(t:YYYY-MM-DD)` recency
                // stamp (graphkit/memory-writer.mjs) — the server ranks by it
                // instead of by file position. Shown as a date rather than
                // left inline, so the row reads as a sentence and not as
                // internal syntax. Facts written before stamping have none.
                if let learned = Self.factStamp(fact) {
                    Text("Learned \(learned)")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.textMuted)
                }
            }
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
        loading = true; error = nil
        // Session memory first, and on its own: it needs no project, and a
        // project-memory failure must not hide what this chat remembers (or
        // the reverse). Best-effort — an empty list is the honest fallback.
        if let sessionId, !sessionId.isEmpty {
            sessionFacts = (try? await api.sessionMemory(sessionId: sessionId)) ?? []
        }
        guard !repos.isEmpty || (workspaceRoot?.isEmpty == false) else { loading = false; return }
        do {
            let r = try await api.projectMemory(repos: repos, workspaceRoot: workspaceRoot)
            facts = r.facts
            resolvedRepo = r.repo
        } catch { self.error = "Couldn't load project memory." }
        loading = false
    }

    /// The recency stamp a fact carries, or nil for one stored before stamping
    /// existed. Mirrors `FACT_STAMP_RE` in `extension/core/fact-key.mjs`.
    static func factStamp(_ fact: String) -> String? {
        guard let r = fact.range(of: #"\(t:\d{4}-\d{2}-\d{2}\)\s*$"#, options: .regularExpression) else { return nil }
        // Keep just the date from `(t:YYYY-MM-DD)`.
        return String(fact[r]).replacingOccurrences(of: #"[()]|t:|\s"#, with: "", options: .regularExpression)
    }

    /// The fact without its stamp. Display only — `remove(_:)` deliberately
    /// sends the UNTOUCHED string, and the server peels the stamp itself
    /// before matching, so trimming here could never desync the two.
    static func factText(_ fact: String) -> String {
        guard let r = fact.range(of: #"\s*\(t:\d{4}-\d{2}-\d{2}\)\s*$"#, options: .regularExpression) else { return fact }
        return String(fact[fact.startIndex..<r.lowerBound])
    }

    private func remove(_ fact: String) async {
        guard !busy, let repo = resolvedRepo else { return }
        busy = true; defer { busy = false }
        do { facts = try await api.deleteProjectMemoryFact(repo: repo, fact: fact, workspaceRoot: workspaceRoot) }
        catch { self.error = "Couldn't update project memory." }
    }

    private func forgetSession() async {
        guard let sessionId, !sessionId.isEmpty else { return }
        busy = true; defer { busy = false }
        do {
            _ = try await api.forgetSessionMemory(sessionId: sessionId)
            sessionFacts = []
        } catch { self.error = "Couldn't forget this chat's memory." }
    }

    private func clearAll() async {
        guard !busy, let repo = resolvedRepo else { return }
        busy = true; defer { busy = false }
        do { facts = try await api.clearProjectMemory(repo: repo, workspaceRoot: workspaceRoot) }
        catch { self.error = "Couldn't clear project memory." }
    }
}
