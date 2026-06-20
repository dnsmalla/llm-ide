// Phase F view — three-pane workspace for the regression check.
//
//   ┌────────────────┬────────────────────────────┬────────────────┐
//   │ Sources        │ Detail                     │ Log            │
//   │  • Fault reports │  Top: Run button + verdict │ Streamed lines │
//   │    (checkbox)  │  Body: fault frontmatter +   │ from the most  │
//   │  • Repo files  │        notes, or code      │ recent run,    │
//   │                │        preview             │ newest-bottom  │
//   └────────────────┴────────────────────────────┴────────────────┘
//
// Selection in the left pane drives what the middle pane renders.
// Checkboxes on fault rows drive what the Run button targets — empty
// selection falls back to "all fixed faults" (Phase D behaviour).

import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct RegressionView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @StateObject private var runner: RegressionRunner

    @State private var selected: SourceSelection?
    @State private var checked: Set<URL> = []
    @State private var allFaults: [URL] = []
    @State private var faultStatuses: [URL: FaultStatus] = [:]

    /// What the middle pane is rendering. `.fault` for a fault report,
    /// `.file` for a peeked repo file (read-only preview).
    enum SourceSelection: Equatable {
        case fault(URL)
        case file(URL)
    }

    init(api: LlmIdeAPIClient) {
        self.api = api
        let prompter = CodeAssistPrompter(api: api, agent: "claude_code")
        // Semantic judge: textual drift between nondeterministic LLM
        // answers only counts as a regression when the judge confirms
        // the meaning changed — without it every reworded answer
        // auto-reopens its fault.
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api)
        _runner = StateObject(wrappedValue: RegressionRunner(
            prompter: prompter, judge: judge,
            verifier: ShellFaultVerifier(), repairer: repairer))
    }

    /// Shared verify-command allowlist — consulted by the detail pane's
    /// "Approve & enable" button and (via the runner) at verify time.
    private let approvals = VerifyApprovalStore()

    var body: some View {
        // Fixed-width sources column (HSplitView overrides a child's width
        // frame); HSplitView drives only the detail ↔ log split.
        HStack(spacing: 0) {
            RegressionSourcesPane(
                repoRoot: activeRepoRoot,
                faults: allFaults,
                faultStatuses: faultStatuses,
                checked: $checked,
                selected: $selected,
                results: runner.results,
                onMarkFixed: { url in Task { await markFixed(url) } }
            )
            .frame(width: 300)
            Divider()

            HSplitView {
            RegressionDetailPane(
                selected: selected,
                checkedCount: checked.count,
                running: runner.running,
                hasRepo: activeRepoRoot != nil,
                results: runner.results,
                approvals: approvals,
                repoRoot: activeRepoRoot,
                onRun: { Task { await runSelected() } },
                onResolved: { Task { await refresh() } }
            )
            .frame(minWidth: 360, maxWidth: .infinity)

            RegressionLogPane(
                lines: runner.log,
                onClear: { runner.clearLog() }
            )
            .frame(minWidth: 240, idealWidth: 300, maxWidth: 420)
            }
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
            allFaults = []
            faultStatuses = [:]
            return
        }
        let store = config.memoryStore
        // Scan + decode every fault frontmatter off the main actor — for a
        // repo with many faults this is non-trivial disk work and must not
        // block the UI thread. Publish the snapshot back on the main actor.
        let snapshot = await Task.detached(priority: .utility) {
            store.faultStatusSnapshot(at: repo)
        }.value
        allFaults = snapshot.urls
        faultStatuses = snapshot.statuses
        // Drop dangling checked URLs (files renamed / deleted).
        let live = Set(snapshot.urls.map { $0.standardizedFileURL.path })
        checked = checked.filter { live.contains($0.standardizedFileURL.path) }
    }

    private func runSelected() async {
        guard let repo = activeRepoRoot else { return }
        let only = checked.isEmpty ? nil : checked
        runner.applyTimeout(config.regressionVerifyTimeout)
        await runner.run(at: repo, only: only,
                         autoReopen: config.regressionAutoReopen,
                         attemptRepair: config.regressionAttemptRepair)
    }

    private func markFixed(_ url: URL) async {
        guard let repo = activeRepoRoot else { return }
        let store = config.memoryStore
        // Flip to fixed immediately so the UI reflects it…
        try? store.updateFaultStatus(at: url, to: .fixed)
        await refresh()
        // …then author a verify command in the background and patch it in.
        if let fault = try? store.loadFault(at: url),
           let cmd = await VerifyCommandAuthor.author(fault: fault, repoRoot: repo, api: api) {
            try? store.markFixed(at: url, verify: cmd)
            await refresh()
        }
    }
}

// MARK: - Sources pane

private struct RegressionSourcesPane: View {
    let repoRoot: URL?
    let faults: [URL]
    let faultStatuses: [URL: FaultStatus]
    @Binding var checked: Set<URL>
    @Binding var selected: RegressionView.SourceSelection?
    let results: [RegressionRunner.Result]
    let onMarkFixed: (URL) -> Void

    @EnvironmentObject var theme: ThemeStore
    @Environment(LibraryItemStore.self) private var libraryStore
    @State private var expandedPaths: Set<String> = []

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            header
            Divider().background(t.border)
            List {
                // Fault-reports section — header mirrors Library tab's
                // colored-icon + SectionLabel style.
                Section {
                    if faults.isEmpty {
                        Text("No fault reports yet")
                            .font(Typography.fileMeta)
                            .foregroundStyle(.quaternary)
                            .listRowSeparator(.hidden)
                    } else {
                        ForEach(faults, id: \.self) { url in
                            faultRow(url)
                        }
                    }
                } header: { faultsSectionHeader }

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
                        let dir = ProjectLayout(root: repo).faultsDir
                        NSWorkspace.shared.activateFileViewerSelecting([dir])
                    } label: {
                        Label("Faults folder", systemImage: "folder")
                            .font(Typography.captionStrong)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Reveal the faults/ directory in Finder")
                }
            }
            if let repo = repoRoot {
                Text(ProjectLayout(root: repo).faultsDir.path)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else {
                Text("Pick an active repo in Settings to surface fault reports.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
    }

    // MARK: - Section headers (match Library style)

    private var faultsSectionHeader: some View {
        // Same shape as FileTreePanel.sectionHeader: small colored
        // icon + SectionLabel — gives the Regression sidebar visual
        // parity with Library's CODE / DATA / NOTES headers.
        HStack(spacing: 5) {
            Image(systemName: "ant.fill")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(theme.current.danger)
            SectionLabel("Fault reports (\(faults.count))")
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

    // MARK: - Fault row

    @ViewBuilder
    private func faultRow(_ url: URL) -> some View {
        let t = theme.current
        let status = faultStatuses[url] ?? .open
        let verdict = results.first(where: { $0.faultURL.standardizedFileURL.path == url.standardizedFileURL.path })?.verdict
        let isSelected: Bool = {
            if case .fault(let u) = selected, u == url { return true }
            return false
        }()
        Button {
            selected = .fault(url)
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
                      : "Only faults with status: fixed can be re-checked")
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
            if status != .fixed {
                Button("Mark as fixed") { onMarkFixed(url) }
            }
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
            case .pending:       return ("pending", t.textMuted)
            case .unchanged:     return ("ok", t.accent3)
            case .regressed:     return ("REGR", t.danger)
            case .repaired:      return ("fixed", t.accent2)
            case .repairFailed:  return ("fix?", t.danger)
            case .needsApproval: return ("approve", t.accent4)
            case .failed:        return ("fail", t.accent4)
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
    let approvals: VerifyApprovalStore
    let repoRoot: URL?
    let onRun: () -> Void
    let onResolved: () -> Void

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
            : (checkedCount == 0 ? "Run all fixed faults" : "Run \(checkedCount) selected")
        return HStack(spacing: Spacing.md) {
            Button(action: onRun) {
                Label(label, systemImage: "play.fill")
                    .font(Typography.captionStrong)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(running || !hasRepo)

            Toggle(isOn: $config.regressionAutoReopen) {
                Text("Auto-reopen regressed")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            .toggleStyle(.checkbox)
            .controlSize(.small)
            .disabled(running)
            .help("When on, a regressed verdict flips the fault back to “open” on disk. Off (default) reports drift without modifying any files — the verdict is a heuristic text comparison.")

            Button("Export pack…") { exportPack() }
                .buttonStyle(.bordered).controlSize(.small).disabled(running || !hasRepo)
            Button("Import pack…") { importPack() }
                .buttonStyle(.bordered).controlSize(.small).disabled(running || !hasRepo)
            HStack(spacing: 4) {
                Text("timeout").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("120", value: $config.regressionVerifyTimeout, format: .number)
                    .frame(width: 50).textFieldStyle(.roundedBorder)
            }

            Spacer()
            if case .fault(let url) = selected,
               let r = results.first(where: { $0.faultURL.standardizedFileURL.path == url.standardizedFileURL.path }) {
                verdictBadge(r)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
    }

    @ViewBuilder
    private var content: some View {
        switch selected {
        case .fault(let url):  faultDetail(url)
        case .file(let url): fileDetail(url)
        case nil:            placeholder
        }
    }

    @ViewBuilder
    private func faultDetail(_ url: URL) -> some View {
        let t = theme.current
        let store = config.memoryStore
        if let fault = try? store.loadFault(at: url) {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Text(url.lastPathComponent)
                        .font(Typography.title)
                        .foregroundStyle(t.text)
                    fmGrid(fault)
                    Divider().background(t.border)
                    sectionHeader("Prompt")
                    Text(fault.prompt)
                        .font(Typography.body)
                        .foregroundStyle(t.text)
                        .textSelection(.enabled)
                    sectionHeader("Response (when fixed)")
                    Text(fault.response)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(t.text)
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
                    if !fault.notes.isEmpty {
                        sectionHeader("Notes")
                        Text(fault.notes)
                            .font(Typography.body)
                            .foregroundStyle(t.text)
                            .textSelection(.enabled)
                    }

                    sectionHeader("Verify command")
                    if let cmd = fault.verify, !cmd.isEmpty {
                        Text(cmd).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        if let repo = repoRoot,
                           !approvals.isApproved(repo: repo, faultFile: url.lastPathComponent, command: cmd) {
                            Button("Approve & enable") {
                                approvals.approve(repo: repo, faultFile: url.lastPathComponent, command: cmd)
                            }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                        }
                    } else {
                        Text("no check — uses answer comparison")
                            .font(Typography.caption).foregroundStyle(t.textMuted)
                    }

                    if let r = results.first(where: { $0.faultURL.standardizedFileURL.path == url.standardizedFileURL.path }),
                       isRepairVerdict(r.verdict),
                       let repo = repoRoot,
                       let diff = try? config.memoryStore.gitDiff(at: repo), !diff.unified.isEmpty {
                        sectionHeader("Repair diff")
                        ScrollView { Text(diff.unified).font(.system(size: 10, design: .monospaced)).textSelection(.enabled) }
                            .frame(maxHeight: 240)
                        HStack {
                            Button("Approve (mark fixed)") {
                                try? config.memoryStore.markFixed(at: url, verify: fault.verify)
                                onResolved()
                            }.buttonStyle(.borderedProminent).controlSize(.small)
                            Button("Discard (revert + reopen)") {
                                try? config.memoryStore.gitCheckout(at: repo, paths: r.repairedPaths)
                                try? config.memoryStore.updateFaultStatus(at: url, to: .open)
                                onResolved()
                            }.buttonStyle(.bordered).controlSize(.small)
                        }
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
    private func fmGrid(_ fault: FaultReport) -> some View {
        let t = theme.current
        let pairs: [(String, String)] = [
            ("severity",   fault.severity.displayName),
            ("status",     fault.status.displayName),
            ("reported",   fault.reportedAt.iso8601String),
            ("git",        fault.gitHead ?? "—"),
            ("app",        fault.appVersion),
            ("agent",      fault.agent),
            ("tags",       fault.tags.isEmpty ? "—" : fault.tags.joined(separator: ", "))
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
        placeholder(text: "Select a fault report or repo file on the left.")
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
            case .repaired:  return ("repaired — re-verify passed", t.accent2)
            case .repairFailed(let why): return ("repair failed — \(why.prefix(40))", t.danger)
            case .needsApproval: return ("needs approval", t.accent4)
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

    private func isRepairVerdict(_ v: RegressionRunner.Verdict) -> Bool {
        if case .repaired = v { return true }
        if case .repairFailed = v { return true }
        return false
    }

    private func exportPack() {
        guard let repo = repoRoot else { return }
        let store = config.memoryStore
        let faults = store.listFaults(at: repo).compactMap { try? store.loadFault(at: $0) }
        guard let data = try? FaultPackService(store: store)
            .export(faults: faults, sourceProject: repo.lastPathComponent, exportedAt: Date()) else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = "faults-pack.json"
        if panel.runModal() == .OK, let url = panel.url { try? data.write(to: url) }
    }

    private func importPack() {
        guard let repo = repoRoot else { return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url, let data = try? Data(contentsOf: url) else { return }
        _ = try? FaultPackService(store: config.memoryStore).importPack(data: data, into: repo)
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
