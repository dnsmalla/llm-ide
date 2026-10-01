import SwiftUI
import SharedProtocol

/// The Mac project's git state, read-only: branch, changed files (with diffs) and recent commits.
/// Staging, committing and pushing stay on the Mac.
struct SourceControlView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: SourceControlStore

    var body: some View {
        List {
            if let s = store.state {
                if !s.isRepo {
                    Section { Text(s.error ?? "This project isn't a git repository.")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                } else {
                    branchSection(s)
                    if let error = s.error {
                        Section { Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.danger) }
                    }
                    filesSections(s)
                    if !s.commits.isEmpty {
                        Section("Recent commits") { ForEach(s.commits) { commitRow($0) } }
                    }
                }
            } else {
                Section {
                    if let error = store.loadError {
                        Text(error).font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    } else {
                        HStack(spacing: DesignSystem.Spacing.sm) {
                            ProgressView()
                            Text(connection.connectionStatus == .connected ? "Loading…" : "Connect to your Mac.")
                                .font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, DesignSystem.Spacing.md)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("Source Control")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            }
        }
        .refreshable { store.refresh() }
        .task { store.refresh() }
        // Opened while offline? Ask again once the link is back instead of spinning forever.
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected, store.state == nil { store.refresh() }
        }
    }

    private func branchSection(_ s: ScmState) -> some View {
        Section {
            HStack {
                Label(s.branch ?? "detached", systemImage: "arrow.triangle.branch")
                    .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                Spacer()
                if s.hasUpstream {
                    Text("↑\(s.ahead)  ↓\(s.behind)").font(DesignSystem.Typography.subheadlineFont.monospacedDigit())
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                        .accessibilityLabel("\(s.ahead) ahead, \(s.behind) behind")
                } else {
                    Text("no upstream").font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
        } footer: {
            Text("Read-only. Stage, commit and push on the Mac.")
        }
    }

    @ViewBuilder
    private func filesSections(_ s: ScmState) -> some View {
        let staged = s.files.filter(\.staged)
        let unstaged = s.files.filter { !$0.staged }
        if s.files.isEmpty {
            Section { Label("Working tree clean", systemImage: "checkmark.circle")
                .foregroundColor(DesignSystem.Colors.success) }
        }
        if !staged.isEmpty { Section("Staged (\(staged.count))") { ForEach(staged) { fileRow($0) } } }
        if !unstaged.isEmpty {
            Section("Changes (\(unstaged.count))") { ForEach(unstaged) { fileRow($0) } }
        }
        if s.filesTruncated {
            Section { Text("Showing the first part of a long change list.")
                .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary) }
        }
    }

    private func fileRow(_ f: ScmFile) -> some View {
        NavigationLink { ScmDiffView(file: f) } label: {
            HStack(spacing: DesignSystem.Spacing.sm) {
                Text(Self.letter(f.status)).font(DesignSystem.Typography.captionFont.weight(.bold).monospaced())
                    .foregroundColor(Self.color(f.status)).frame(width: 18)
                VStack(alignment: .leading, spacing: 0) {
                    Text((f.path as NSString).lastPathComponent).font(DesignSystem.Typography.bodyFont).lineLimit(1)
                    if (f.path as NSString).deletingLastPathComponent != "" {
                        Text((f.path as NSString).deletingLastPathComponent)
                            .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary).lineLimit(1)
                    }
                }
            }
        }
    }

    private func commitRow(_ c: ScmCommit) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(c.subject).font(DesignSystem.Typography.subheadlineFont).lineLimit(2)
            Text("\(c.sha) · \(c.author) · \(c.relativeDate)")
                .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
        }
    }

    static func letter(_ status: String) -> String {
        switch status {
        case "added": return "A"
        case "modified": return "M"
        case "deleted": return "D"
        case "renamed": return "R"
        case "untracked": return "U"
        case "conflicted": return "!"
        default: return "?"
        }
    }
    static func color(_ status: String) -> Color {
        switch status {
        case "added", "untracked": return DesignSystem.Colors.success
        case "deleted", "conflicted": return DesignSystem.Colors.danger
        default: return DesignSystem.Colors.primary
        }
    }
}

struct ScmDiffView: View {
    let file: ScmFile
    @EnvironmentObject var store: SourceControlStore
    @EnvironmentObject var connection: ConnectionService

    var body: some View {
        let result = store.diffs[SourceControlStore.key(file.path, file.staged)]
        ScrollView {
            if let result {
                if let error = result.error {
                    Text(error).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary)
                        .padding(DesignSystem.Spacing.md)
                } else if let text = result.diff {
                    VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
                        if result.truncated {
                            Label("Long diff — showing the first part.", systemImage: "scissors")
                                .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        DiffTextView(text: text)
                    }
                    .padding(DesignSystem.Spacing.sm)
                }
            } else {
                ProgressView().padding(.top, 60).frame(maxWidth: .infinity)
            }
        }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle((file.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task { if result == nil || result?.error != nil { store.loadDiff(file) } }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected, store.diffs[SourceControlStore.key(file.path, file.staged)] == nil { store.loadDiff(file) }
        }
    }
}

/// Renders long text a chunk of lines at a time. A `LazyVStack` inside a scroll view that also scrolls
/// sideways is not lazy (its nearest scroll axis is the horizontal one), so laying out a 100k-character
/// diff or a 5 000-line file at once froze the screen; instead the first chunk is shown and the rest is
/// one tap away.
struct ChunkedLinesView<Row: View>: View {
    let text: String
    var chunk = 400
    @ViewBuilder let row: (Int, String) -> Row
    @State private var lines: [String] = []
    @State private var shown = 400

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.prefix(shown).enumerated()), id: \.offset) { index, line in
                        row(index, line)
                    }
                }
            }
            if lines.count > shown {
                Button("Show \(min(chunk, lines.count - shown)) more lines (\(lines.count - shown) left)") { shown += chunk }
                    .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                    .padding(.vertical, DesignSystem.Spacing.sm)
            }
        }
        // Split once per text, not on every body evaluation.
        .task(id: text.hashValue) {
            lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            shown = chunk
        }
    }
}

/// A unified diff with added/removed/hunk lines coloured, shown in chunks (see `ChunkedLinesView`).
struct DiffTextView: View {
    let text: String

    var body: some View {
        ChunkedLinesView(text: text) { _, line in
            Text(line.isEmpty ? " " : line)
                .font(DesignSystem.Typography.codeFont)
                .foregroundColor(Self.color(for: line))
                .padding(.horizontal, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Self.background(for: line))
                .textSelection(.enabled)
        }
    }

    private static func color(for line: String) -> Color {
        line.hasPrefix("@@") ? DesignSystem.Colors.primary : DesignSystem.Colors.textPrimary
    }
    private static func background(for line: String) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") { return .clear }
        if line.hasPrefix("+") { return DesignSystem.Colors.success.opacity(0.14) }
        if line.hasPrefix("-") { return DesignSystem.Colors.danger.opacity(0.14) }
        return .clear
    }
}
