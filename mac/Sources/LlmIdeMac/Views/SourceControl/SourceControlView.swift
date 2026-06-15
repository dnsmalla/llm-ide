import SwiftUI

/// Cursor-style Source Control panel over the active cloned repo. Two-pane
/// HSplitView: left = branch header + staged/unstaged file groups + commit
/// box; right = the colored unified diff of the selected file. Empty state
/// when no repo is active. Discard goes through a destructive confirmation.
struct SourceControlView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(\.controlActiveState) private var controlActiveState
    @State private var scm = SourceControlService()
    @State private var selected: FileChange?
    @State private var hunks: [DiffHunk] = []
    @State private var message: String = ""
    @State private var confirmDiscard: FileChange?

    private var root: URL? { config.activeRepoLocalURL }

    var body: some View {
        Group {
            if let root {
                HSplitView {
                    leftPane(root).frame(minWidth: 280, idealWidth: 340, maxWidth: 520)
                    UnifiedDiffView(hunks: hunks).frame(minWidth: 360)
                }
            } else {
                emptyState
            }
        }
        .background(theme.current.body)
        .task(id: root?.path) { await scm.refresh(root: root) }
        // Fix 1: refresh when window becomes key (picks up external changes)
        .onChange(of: controlActiveState) { _, new in
            if new == .key, let root {
                Task { await scm.refresh(root: root) }
            }
        }
        // Fix 2: re-resolve selection by path after any file-list mutation so the
        // diff pane stays correct after stage/unstage/discard
        .onChange(of: scm.state.files) { _, files in
            guard let sel = selected else { hunks = []; return }
            guard let root else { return }
            // Prefer the unstaged copy; fall back to staged (e.g. freshly staged file)
            let resolved = files.first(where: { $0.path == sel.path && !$0.staged })
                         ?? files.first(where: { $0.path == sel.path && $0.staged })
            if let resolved {
                selected = resolved
                Task { hunks = await scm.diff(root: root, path: resolved.path, staged: resolved.staged) }
            } else {
                selected = nil
                hunks = []
            }
        }
        .onChange(of: selected) { _, sel in
            guard let sel, let root else { hunks = []; return }
            Task { hunks = await scm.diff(root: root, path: sel.path, staged: sel.staged) }
        }
        .confirmationDialog("Discard changes?", isPresented: Binding(
            get: { confirmDiscard != nil }, set: { if !$0 { confirmDiscard = nil } }
        ), presenting: confirmDiscard) { file in
            Button("Discard \(file.displayPath)", role: .destructive) {
                if let root { Task { await scm.discard(root: root, file: file); confirmDiscard = nil } }
            }
        } message: { file in
            Text(file.status == .untracked
                 ? "“\(file.displayPath)” will be deleted."
                 : "Changes to “\(file.displayPath)” will be lost.")
        }
    }

    @ViewBuilder private func leftPane(_ root: URL) -> some View {
        VStack(spacing: 0) {
            branchHeader(root)
            Divider().background(theme.current.border)
            ScrollView {
                if let err = scm.state.error { errorBanner(err) }
                fileGroup("Staged Changes", scm.stagedFiles, root)
                fileGroup("Changes", scm.unstagedFiles, root)
            }
            Divider().background(theme.current.border)
            commitBox(root)
        }
    }

    private func branchHeader(_ root: URL) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 12))
            Text(scm.state.branch ?? "—").font(Typography.bodyStrong)
            if scm.state.ahead > 0 { Text("↑\(scm.state.ahead)").font(Typography.caption) }
            if scm.state.behind > 0 { Text("↓\(scm.state.behind)").font(Typography.caption) }
            Spacer()
            Button { Task { await scm.refresh(root: root) } } label: {
                Image(systemName: "arrow.clockwise")
            }.buttonStyle(.plain).help("Refresh")
        }
        .foregroundStyle(theme.current.text)
        .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.sm)
    }

    @ViewBuilder private func fileGroup(_ title: String, _ files: [FileChange], _ root: URL) -> some View {
        if !files.isEmpty {
            Text("\(title) (\(files.count))")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Spacing.md).padding(.top, Spacing.sm)
            ForEach(files) { file in
                fileRow(file, root)
            }
        }
    }

    private func fileRow(_ file: FileChange, _ root: URL) -> some View {
        HStack(spacing: Spacing.xs) {
            Text(badge(file.status)).font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(color(file.status)).frame(width: 14)
            Text(file.displayPath).font(Typography.caption).lineLimit(1).truncationMode(.middle)
            Spacer()
            if file.staged {
                Button { Task { await scm.unstage(root: root, path: file.path) } } label: {
                    Image(systemName: "minus") }.buttonStyle(.plain).help("Unstage")
            } else {
                Button { Task { await scm.stage(root: root, path: file.path) } } label: {
                    Image(systemName: "plus") }.buttonStyle(.plain).help("Stage")
                Button { confirmDiscard = file } label: {
                    Image(systemName: "arrow.uturn.backward") }.buttonStyle(.plain).help("Discard")
            }
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, 3)
        .background(selected == file ? theme.current.accent.opacity(0.12) : .clear)
        .contentShape(Rectangle())
        .onTapGesture { selected = file }
    }

    private func commitBox(_ root: URL) -> some View {
        VStack(spacing: Spacing.xs) {
            TextField("Commit message", text: $message, axis: .vertical)
                .textFieldStyle(.plain).lineLimit(1...4)
                .padding(Spacing.sm)
                .background(theme.current.surface2).clipShape(RoundedRectangle(cornerRadius: Radius.sm))
            Button {
                let msg = message
                Task { await scm.commit(root: root, message: msg); message = "" }
            } label: { Text("Commit").frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
            .disabled(scm.stagedFiles.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(Spacing.md)
    }

    private func errorBanner(_ msg: String) -> some View {
        Text(msg).font(Typography.caption).foregroundStyle(theme.current.danger)
            .padding(Spacing.sm).frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.sm) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 28))
                .foregroundStyle(theme.current.textMuted)
            Text("No active repository").font(Typography.bodyStrong)
            Text("Activate a cloned repo in Settings → GitLab / GitHub.")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func badge(_ s: FileChange.Status) -> String {
        switch s {
        case .added: return "A"
        case .modified: return "M"
        case .deleted: return "D"
        case .renamed: return "R"
        case .untracked: return "U"
        case .conflicted: return "C"
        }
    }
    private func color(_ s: FileChange.Status) -> Color {
        switch s {
        case .added, .untracked: return .green
        case .deleted: return .red
        case .conflicted: return .orange
        default: return theme.current.accent2
        }
    }
}
