// Phase F view — three-pane workspace for the regression check.
//
//   ┌────────────────┬────────────────────────────┬────────────────┐
//   │ Sources        │ Detail                     │ Log            │
//   │  • Bug reports │  Top: Run button + verdict │ Streamed lines │
//   │    (checkbox)  │  Body: bug frontmatter +   │ from the most  │
//   │  • Repo files  │        notes, or code      │ recent run,    │
//   │                │        preview             │ newest-bottom  │
//   └────────────────┴────────────────────────────┴────────────────┘
//
// Selection in the left pane drives what the middle pane renders.
// Checkboxes on bug rows drive what the Run button targets — empty
// selection falls back to "all fixed bugs" (Phase D behaviour).

import SwiftUI

struct RegressionView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @StateObject private var runner: RegressionRunner

    @State private var selected: SourceSelection?
    @State private var checked: Set<URL> = []
    @State private var allBugs: [URL] = []
    @State private var bugStatuses: [URL: BugStatus] = [:]

    /// What the middle pane is rendering. `.bug` for a bug report,
    /// `.file` for a peeked repo file (read-only preview).
    enum SourceSelection: Equatable {
        case bug(URL)
        case file(URL)
    }

    init(api: LlmIdeAPIClient) {
        self.api = api
        let prompter = CodeAssistPrompter(api: api, agent: "claude_code")
        _runner = StateObject(wrappedValue: RegressionRunner(prompter: prompter))
    }

    var body: some View {
        HSplitView {
            RegressionSourcesPane(
                repoRoot: activeRepoRoot,
                bugs: allBugs,
                bugStatuses: bugStatuses,
                checked: $checked,
                selected: $selected,
                results: runner.results
            )
            .frame(minWidth: 260, idealWidth: 320, maxWidth: 480)

            RegressionDetailPane(
                selected: selected,
                checkedCount: checked.count,
                running: runner.running,
                hasRepo: activeRepoRoot != nil,
                results: runner.results,
                onRun: { Task { await runSelected() } }
            )
            .frame(minWidth: 360, idealWidth: 560)

            RegressionLogPane(
                lines: runner.log,
                onClear: { runner.clearLog() }
            )
            .frame(minWidth: 240, idealWidth: 300, maxWidth: 420)
        }
        .background(theme.current.body)
        .onAppear { runner.config = config }
        .task(id: activeRepoRoot?.path) { await refresh() }
        .onChange(of: runner.running) { _, isRunning in
            if !isRunning { Task { await refresh() } }
        }
    }

    // MARK: - State helpers

    private var activeRepoRoot: URL? { config.activeRepoLocalURL }

    private func refresh() async {
        guard let repo = activeRepoRoot else {
            allBugs = []
            bugStatuses = [:]
            return
        }
        let store = config.memoryStore
        let urls = store.listBugs(at: repo)
        var statuses: [URL: BugStatus] = [:]
        for u in urls {
            if let bug = try? store.loadBug(at: u) {
                statuses[u] = bug.status
            }
        }
        allBugs = urls
        bugStatuses = statuses
        // Drop dangling checked URLs (files renamed / deleted).
        let live = Set(urls.map { $0.standardizedFileURL.path })
        checked = checked.filter { live.contains($0.standardizedFileURL.path) }
    }

    private func runSelected() async {
        guard let repo = activeRepoRoot else { return }
        let only = checked.isEmpty ? nil : checked
        await runner.run(at: repo, only: only)
    }
}

// MARK: - Sources pane

private struct RegressionSourcesPane: View {
    let repoRoot: URL?
    let bugs: [URL]
    let bugStatuses: [URL: BugStatus]
    @Binding var checked: Set<URL>
    @Binding var selected: RegressionView.SourceSelection?
    let results: [RegressionRunner.Result]

    @EnvironmentObject var theme: ThemeStore
    @Environment(LibraryItemStore.self) private var libraryStore
    @State private var expandedPaths: Set<String> = []

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            header
            Divider().background(t.border)
            List {
                // Bug-reports section — header mirrors Library tab's
                // colored-icon + SectionLabel style.
                Section {
                    if bugs.isEmpty {
                        Text("No bug reports yet")
                            .font(Typography.fileMeta)
                            .foregroundStyle(.quaternary)
                            .listRowSeparator(.hidden)
                    } else {
                        ForEach(bugs, id: \.self) { url in
                            bugRow(url)
                        }
                    }
                } header: { bugsSectionHeader }

                // CODE section — drives off LibraryItemStore so the
                // contents match Library tab's CODE section exactly
                // (same tracked items, same tree shape rooted at
                // each folder-origin). FSNode + buildTree are
                // shared with FileTreePanel.
                let codeTrees = buildCodeTrees()
                Section {
                    if codeTrees.isEmpty {
                        Text("No code in Library yet — add a repo from Settings → GitLab / GitHub.")
                            .font(Typography.fileMeta)
                            .foregroundStyle(.quaternary)
                            .listRowSeparator(.hidden)
                    } else {
                        ForEach(codeTrees) { root in
                            RepoFileTreeRow(
                                node: root,
                                depth: 0,
                                expandedPaths: $expandedPaths,
                                isSelected: { sel in
                                    if case .file(let u) = selected, u == sel { return true }
                                    return false
                                },
                                onSelect: { url in selected = .file(url) }
                            )
                        }
                    }
                } header: { codeSectionHeader }
            }
            .listStyle(.sidebar)
        }
        .background(t.surface)
    }

    // MARK: - Pane header (path + Finder reveal)

    private var header: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionLabel("REGRESSION")
                Spacer()
                if let repo = repoRoot {
                    Button {
                        let dir = repo.appendingPathComponent(".understand-anything/memory/bugs",
                                                              isDirectory: true)
                        NSWorkspace.shared.activateFileViewerSelecting([dir])
                    } label: {
                        Label("Bugs folder", systemImage: "folder")
                            .font(Typography.captionStrong)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Reveal the bugs/ directory in Finder")
                }
            }
            if let repo = repoRoot {
                Text(repo.appendingPathComponent(".understand-anything/memory/bugs").path)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else {
                Text("Pick an active repo in Settings to surface bug reports.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
    }

    // MARK: - Section headers (match Library style)

    private var bugsSectionHeader: some View {
        // Same shape as FileTreePanel.sectionHeader: small colored
        // icon + SectionLabel — gives the Regression sidebar visual
        // parity with Library's CODE / DATA / NOTES headers.
        HStack(spacing: 5) {
            Image(systemName: "ant.fill")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(theme.current.danger)
            SectionLabel("Bug reports (\(bugs.count))")
            Spacer(minLength: 0)
        }
    }

    private var codeSectionHeader: some View {
        // Match the Library tab's CODE header exactly — same icon
        // (chevron.left.forwardslash.chevron.right) and same tint
        // (LibraryItem.Category.code.uiColor).
        HStack(spacing: 5) {
            Image(systemName: LibraryItem.Category.code.icon)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(LibraryItem.Category.code.uiColor)
            SectionLabel("Code")
            Spacer(minLength: 0)
        }
    }

    // MARK: - Code trees (delegates to the shared helper in
    //         FileTreePanel.swift so Library + Regression can't
    //         drift on grouping / sorting).

    private func buildCodeTrees() -> [FSNode] {
        buildCategoryTrees(items: libraryStore.items(for: .code))
    }

    // MARK: - Bug row

    @ViewBuilder
    private func bugRow(_ url: URL) -> some View {
        let t = theme.current
        let status = bugStatuses[url] ?? .open
        let verdict = results.first(where: { $0.bugURL.standardizedFileURL.path == url.standardizedFileURL.path })?.verdict
        let isSelected: Bool = {
            if case .bug(let u) = selected, u == url { return true }
            return false
        }()
        Button {
            selected = .bug(url)
        } label: {
            HStack(spacing: 4) {
                Toggle("", isOn: Binding(
                    get: { checked.contains(url) },
                    set: { isOn in
                        if isOn { checked.insert(url) } else { checked.remove(url) }
                    }
                ))
                .labelsHidden()
                .disabled(status != .fixed)
                .help(status == .fixed
                      ? "Include in the next regression run"
                      : "Only bugs with status: fixed can be re-checked")
                Image(systemName: "ant")
                    .font(.system(size: 11))
                    .foregroundStyle(status.tint(t))
                    .frame(width: 16)
                Text(url.lastPathComponent)
                    .font(Typography.filename)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let v = verdict { verdictPill(v) }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
        .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
        }
    }


    @ViewBuilder
    private func verdictPill(_ v: RegressionRunner.Verdict) -> some View {
        let t = theme.current
        let (label, color): (String, Color) = {
            switch v {
            case .pending:   return ("pending", t.textMuted)
            case .unchanged: return ("ok", t.accent3)
            case .regressed: return ("REGR", t.danger)
            case .failed:    return ("fail", t.accent4)
            }
        }()
        Text(label)
            .font(.system(size: 8, weight: .heavy, design: .rounded))
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.18)))
            .foregroundStyle(color)
    }

}

// MARK: - Detail pane

private struct RegressionDetailPane: View {
    let selected: RegressionView.SourceSelection?
    let checkedCount: Int
    let running: Bool
    let hasRepo: Bool
    let results: [RegressionRunner.Result]
    let onRun: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            toolbar
            Divider().background(t.border)
            content
        }
        .background(t.body)
    }

    private var toolbar: some View {
        let t = theme.current
        let label = running
            ? "Running…"
            : (checkedCount == 0 ? "Run all fixed bugs" : "Run \(checkedCount) selected")
        return HStack(spacing: Spacing.md) {
            Button(action: onRun) {
                Label(label, systemImage: "play.fill")
                    .font(Typography.captionStrong)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(running || !hasRepo)
            Spacer()
            if case .bug(let url) = selected,
               let r = results.first(where: { $0.bugURL.standardizedFileURL.path == url.standardizedFileURL.path }) {
                verdictBadge(r)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
    }

    @ViewBuilder
    private var content: some View {
        switch selected {
        case .bug(let url):  bugDetail(url)
        case .file(let url): fileDetail(url)
        case nil:            placeholder
        }
    }

    @ViewBuilder
    private func bugDetail(_ url: URL) -> some View {
        let t = theme.current
        let store = config.memoryStore
        if let bug = try? store.loadBug(at: url) {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Text(url.lastPathComponent)
                        .font(Typography.title)
                        .foregroundStyle(t.text)
                    fmGrid(bug)
                    Divider().background(t.border)
                    sectionHeader("Prompt")
                    Text(bug.prompt)
                        .font(Typography.body)
                        .foregroundStyle(t.text)
                        .textSelection(.enabled)
                    sectionHeader("Response (when fixed)")
                    Text(bug.response)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(t.text)
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
                    if !bug.notes.isEmpty {
                        sectionHeader("Notes")
                        Text(bug.notes)
                            .font(Typography.body)
                            .foregroundStyle(t.text)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.lg)
            }
        } else {
            placeholder(text: "Couldn't decode \(url.lastPathComponent).")
        }
    }

    @ViewBuilder
    private func fmGrid(_ bug: BugReport) -> some View {
        let t = theme.current
        let pairs: [(String, String)] = [
            ("severity",   bug.severity.displayName),
            ("status",     bug.status.displayName),
            ("reported",   bug.reportedAt.iso8601String),
            ("git",        bug.gitHead ?? "—"),
            ("app",        bug.appVersion),
            ("agent",      bug.agent),
            ("tags",       bug.tags.isEmpty ? "—" : bug.tags.joined(separator: ", "))
        ]
        LazyVGrid(columns: [
            GridItem(.fixed(80), alignment: .topLeading),
            GridItem(.flexible(), alignment: .topLeading)
        ], spacing: 4) {
            ForEach(pairs, id: \.0) { (k, v) in
                Text(k).font(Typography.caption).foregroundStyle(t.textMuted)
                Text(v).font(Typography.caption).foregroundStyle(t.text)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private func fileDetail(_ url: URL) -> some View {
        let t = theme.current
        let raw = (try? String(contentsOf: url, encoding: .utf8)) ?? "(binary or unreadable)"
        let lines = raw.split(separator: "\n", omittingEmptySubsequences: false)
        let limit = 200
        let shown = lines.prefix(limit).joined(separator: "\n")
        let truncated = lines.count > limit
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                Text(url.lastPathComponent)
                    .font(Typography.title)
                    .foregroundStyle(t.text)
                Text(url.path)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Divider().background(t.border)
                Text(shown)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(t.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if truncated {
                    Text("… truncated (\(lines.count - limit) more lines)")
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                }
            }
            .padding(Spacing.lg)
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        placeholder(text: "Select a bug report or repo file on the left.")
    }

    @ViewBuilder
    private func placeholder(text: String) -> some View {
        let t = theme.current
        VStack {
            Spacer()
            Text(text)
                .font(Typography.body)
                .foregroundStyle(t.textMuted)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Spacing.lg)
    }

    @ViewBuilder
    private func sectionHeader(_ s: String) -> some View {
        Text(s)
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
    }

    @ViewBuilder
    private func verdictBadge(_ r: RegressionRunner.Result) -> some View {
        let t = theme.current
        let (label, color): (String, Color) = {
            switch r.verdict {
            case .pending:   return ("pending", t.textMuted)
            case .unchanged: return ("unchanged", t.accent3)
            case .regressed: return ("REGRESSED", t.danger)
            case .failed(let why): return ("failed — \(why.prefix(40))", t.accent4)
            }
        }()
        HStack(spacing: 4) {
            if r.autoReopened {
                Text("auto-reopened")
                    .font(.system(size: 9, weight: .heavy, design: .rounded))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(t.danger.opacity(0.18)))
                    .foregroundStyle(t.danger)
            }
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(color)
        }
    }

}

// MARK: - Log pane

private struct RegressionLogPane: View {
    let lines: [RegressionRunner.LogLine]
    let onClear: () -> Void

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            HStack {
                SectionLabel("RUN LOG")
                Spacer()
                Button("Clear", action: onClear)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(lines.isEmpty)
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.sm)
            Divider().background(t.border)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        if lines.isEmpty {
                            Text("No runs yet.")
                                .font(Typography.caption)
                                .foregroundStyle(t.textMuted)
                                .padding(Spacing.lg)
                        }
                        ForEach(lines) { line in
                            logRow(line)
                                .id(line.id)
                        }
                    }
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, 4)
                }
                .onChange(of: lines.count) { _, _ in
                    if let last = lines.last {
                        withAnimation(.linear(duration: 0.1)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .background(t.surface)
    }

    @ViewBuilder
    private func logRow(_ line: RegressionRunner.LogLine) -> some View {
        let t = theme.current
        HStack(alignment: .top, spacing: 6) {
            Text(AppDateFormatter.hourMinuteSecond(line.at))
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(t.textMuted)
            levelDot(line.level)
            Text(line.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(levelColor(line.level))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func levelDot(_ l: RegressionRunner.LogLine.Level) -> some View {
        Circle()
            .fill(levelColor(l))
            .frame(width: 5, height: 5)
            .padding(.top, 5)
    }

    private func levelColor(_ l: RegressionRunner.LogLine.Level) -> Color {
        let t = theme.current
        switch l {
        case .info:  return t.text
        case .warn:  return t.accent4
        case .error: return t.danger
        }
    }

}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
