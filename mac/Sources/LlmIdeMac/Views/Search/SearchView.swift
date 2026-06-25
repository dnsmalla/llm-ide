import SwiftUI

struct SearchView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore
    @State private var searchService = SearchService()

    // Find state
    @State private var query = ""
    @State private var options = SearchOptions()
    @State private var include = ""
    @State private var exclude = ""
    @State private var results = SearchResults()

    // View state. Files default to expanded; `collapsed` records the ones the
    // user explicitly closed, so the absence of an id == expanded.
    @State private var collapsed: Set<String> = []
    @State private var dismissed: Set<String> = []        // per-match key, view-only hide

    // Replace state
    @State private var replaceText = ""
    @State private var preserveCase = false
    @State private var showReplace = false
    @State private var confirmReplaceAll = false

    // Editor pane
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?

    // Search lifecycle
    @State private var debounce: Task<Void, Never>?
    @State private var searching = false

    private var root: URL? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }

    var body: some View {
        VStack(spacing: 0) {
            searchHeaderBar
            Divider()
            content
        }
    }

    /// Thin panel header mirroring Explorer's / Source Control's, carrying the
    /// Explorer · Source Control · Search switcher.
    private var searchHeaderBar: some View {
        HStack(spacing: 6) {
            PanelSectionTabs()
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.bar)
    }

    @ViewBuilder
    private var content: some View {
        if root == nil {
            emptyState("Open a project or activate a repo to search")
        } else {
            // Fixed-width results column — HSplitView overrides a child's
            // width frame, so pin it outside the split to keep it minimal.
            HStack(spacing: 0) {
                resultsPane.frame(width: 300)
                Divider()
                editorPane.frame(minWidth: 360, maxWidth: .infinity)
            }
            .onChange(of: options) { _, _ in scheduleSearch() }
        }
    }

    // MARK: - Left pane

    private var resultsPane: some View {
        VStack(spacing: 0) {
            searchControls
            Divider()
            resultsHeader
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(visibleFiles) { fm in
                        fileGroup(fm)
                    }
                }
            }
        }
    }

    // MARK: Controls

    private var searchControls: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Button {
                    showReplace.toggle()
                } label: {
                    Image(systemName: showReplace ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 14)
                }
                .buttonStyle(.plain)
                .help(showReplace ? "Hide replace" : "Show replace")

                findField
            }
            if showReplace { replaceRow }
            includeExcludeFields
        }
        .padding(8)
    }

    private var findField: some View {
        HStack(spacing: 6) {
            TextField("Search", text: $query)
                .textFieldStyle(.plain)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(theme.current.surface2)
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.sm)
                        .stroke(results.invalidPattern ? theme.current.danger : Color.clear, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                .onChange(of: query) { _, _ in scheduleSearch() }

            toggle("Aa", on: options.caseSensitive, help: "Match case") { options.caseSensitive.toggle() }
            toggle("ab", on: options.wholeWord, help: "Whole word") { options.wholeWord.toggle() }
            toggle(".*", on: options.regex, help: "Use regex") { options.regex.toggle() }
        }
    }

    private var replaceAllDisabled: Bool {
        replaceText.isEmpty || results.files.isEmpty || searching
    }

    private var replaceRow: some View {
        HStack(spacing: 6) {
            Spacer().frame(width: 14)
            TextField("Replace", text: $replaceText)
                .textFieldStyle(.plain)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(theme.current.surface2)
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
            toggle("AB", on: preserveCase, help: "Preserve case") { preserveCase.toggle() }
            Button("Replace All") { confirmReplaceAll = true }
                .buttonStyle(.plain)
                .font(Typography.caption)
                .foregroundStyle(replaceAllDisabled ? theme.current.textMuted : theme.current.accent)
                .disabled(replaceAllDisabled)
                .help("Replace all matches")
                .confirmationDialog(
                    "Replace all matches in \(results.files.count) files?",
                    isPresented: $confirmReplaceAll, titleVisibility: .visible
                ) {
                    Button("Replace All", role: .destructive) { replaceAllAction() }
                    Button("Cancel", role: .cancel) {}
                }
        }
    }

    private var includeExcludeFields: some View {
        VStack(spacing: 6) {
            globField("files to include", text: $include)
            globField("files to exclude", text: $exclude)
        }
    }

    private func globField(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(Typography.caption).foregroundStyle(theme.current.textMuted)
            TextField("e.g. app/job/**, *.swift", text: text)
                .textFieldStyle(.plain)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(theme.current.surface2)
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                .onChange(of: text.wrappedValue) { _, _ in scheduleSearch() }
        }
    }

    private func toggle(_ label: String, on: Bool, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(on ? theme.current.accent : theme.current.textMuted)
                .frame(width: 22, height: 22)
                .background(on ? theme.current.accent.opacity(0.15) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
        }
        .buttonStyle(.plain)
        .help(help)
    }

    // MARK: Header

    @ViewBuilder private var resultsHeader: some View {
        HStack(spacing: 6) {
            if searching { ProgressView().controlSize(.small) }
            Text(headerText)
                .font(Typography.caption)
                .foregroundStyle(results.invalidPattern ? theme.current.danger : theme.current.textMuted)
            Spacer()
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
    }

    private var headerText: String {
        if results.invalidPattern { return "Invalid pattern" }
        if !query.isEmpty && results.files.isEmpty && !searching { return "No results" }
        if results.files.isEmpty { return "" }
        return "\(results.totalMatches) results in \(results.files.count) files"
    }

    // MARK: File group

    @ViewBuilder private func fileGroup(_ fm: FileMatch) -> some View {
        DisclosureGroup(isExpanded: Binding(
            get: { !collapsed.contains(fm.id) },
            set: { open in if open { collapsed.remove(fm.id) } else { collapsed.insert(fm.id) } }
        )) {
            ForEach(visibleLineMatches(fm), id: \.self) { lm in
                lineRow(fm, lm)
            }
        } label: {
            fileHeader(fm)
        }
        .padding(.horizontal, 8)
    }

    private func fileHeader(_ fm: FileMatch) -> some View {
        FileHeaderRow(
            fm: fm,
            badge: fileBadgeCount(fm),
            canReplace: showReplace && !replaceText.isEmpty,
            text: theme.current.text,
            muted: theme.current.textMuted,
            surface: theme.current.surface2,
            onReplaceAll: { replaceInFileAction(fm) }
        )
    }

    @ViewBuilder private func lineRow(_ fm: FileMatch, _ lm: LineMatch) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("\(lm.line)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(theme.current.textMuted)
                .frame(width: 36, alignment: .trailing)
            Text(highlighted(lm))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.current.text)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 16)
        }
        .padding(.horizontal, 6).padding(.vertical, 1)
        .contentShape(Rectangle())
        .onTapGesture { open(fm.url) }
        .modifier(RowHoverActions(
            canReplace: showReplace && !replaceText.isEmpty,
            onReplace: { if let m = lm.matches.first { replaceOneAction(fm, fileIndex: m.fileIndex) } },
            onDismiss: { dismiss(fm, lm) }
        ))
    }

    // MARK: - Right pane

    @ViewBuilder private var editorPane: some View {
        VStack(spacing: 0) {
            if !tabs.isEmpty { EditorTabBar(tabs: $tabs, activeTab: $activeTab); Divider() }
            if let activeTab { FileDetailView(url: activeTab).id(activeTab) }
            else { emptyState("Select a result to open") }
        }
    }

    private func emptyState(_ msg: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 26)).foregroundStyle(theme.current.textMuted)
            Text(msg).font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Highlighting

    /// Build an AttributedString from the *same* `lineText` the NSRanges were
    /// computed against in Wave 1 (NSString/UTF-16). `Range(nsRange, in: lineText)`
    /// maps each UTF-16 NSRange back to a Swift `String.Index` range over that
    /// exact line — correct for multibyte text (e.g. 出力調整禁止) because the
    /// engine measured length on `lineText as NSString`, so the offsets line up.
    private func highlighted(_ lm: LineMatch) -> AttributedString {
        var attr = AttributedString(lm.lineText)
        let bg = theme.current.accent.opacity(0.35)
        for m in lm.matches {
            guard let swiftRange = Range(m.nsRange, in: lm.lineText),
                  let lo = AttributedString.Index(swiftRange.lowerBound, within: attr),
                  let hi = AttributedString.Index(swiftRange.upperBound, within: attr) else { continue }
            attr[lo..<hi].backgroundColor = bg
            attr[lo..<hi].inlinePresentationIntent = .stronglyEmphasized
        }
        return attr
    }

    // MARK: - Filtering helpers

    private var visibleFiles: [FileMatch] {
        results.files.filter { !visibleLineMatches($0).isEmpty }
    }

    private func visibleLineMatches(_ fm: FileMatch) -> [LineMatch] {
        fm.lineMatches.filter { lm in
            lm.matches.contains { !dismissed.contains(key(fm, lm.line, $0.fileIndex)) }
        }
    }

    private func fileBadgeCount(_ fm: FileMatch) -> Int {
        fm.lineMatches.reduce(0) { acc, lm in
            acc + lm.matches.filter { !dismissed.contains(key(fm, lm.line, $0.fileIndex)) }.count
        }
    }

    private func key(_ fm: FileMatch, _ line: Int, _ fileIndex: Int) -> String {
        "\(fm.id):\(line):\(fileIndex)"
    }

    private func dismiss(_ fm: FileMatch, _ lm: LineMatch) {
        for m in lm.matches { dismissed.insert(key(fm, lm.line, m.fileIndex)) }
    }

    // MARK: - Actions

    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }

    // MARK: Replace actions (re-search after so results reflect the new state)

    private func replaceAllAction() {
        let files = results.files, q = query, opts = options, repl = replaceText, pc = preserveCase
        Task {
            _ = await searchService.replaceAll(in: files, query: q, options: opts, replacement: repl, preserveCase: pc)
            scheduleSearch()
        }
    }

    private func replaceInFileAction(_ fm: FileMatch) {
        let url = fm.url, q = query, opts = options, repl = replaceText, pc = preserveCase
        Task {
            _ = await searchService.replaceInFile(file: url, query: q, options: opts, replacement: repl, preserveCase: pc)
            scheduleSearch()
        }
    }

    private func replaceOneAction(_ fm: FileMatch, fileIndex: Int) {
        let url = fm.url, q = query, opts = options, repl = replaceText, pc = preserveCase
        Task {
            _ = await searchService.replaceOne(file: url, fileIndex: fileIndex, query: q, options: opts, replacement: repl, preserveCase: pc)
            scheduleSearch()
        }
    }

    private func scheduleSearch() {
        debounce?.cancel()
        // Dismissals are positional (path:line:fileIndex), so they're only valid
        // for the current result set — clear them when the query/options/globs
        // change, otherwise a dismissal can phantom-hide a different match at the
        // same position in the new results.
        dismissed.removeAll()
        guard let root else { results = SearchResults(); return }
        let q = query
        let opts = options
        let inc = include
        let exc = exclude
        debounce = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            searching = true
            defer { searching = false }
            let r = await searchService.search(query: q, root: root, options: opts, include: inc, exclude: exc)
            if Task.isCancelled { return }
            results = r
        }
    }
}

// MARK: - Row hover actions

/// On hover: an optional single-match Replace button plus the `×` dismiss.
private struct RowHoverActions: ViewModifier {
    let canReplace: Bool
    let onReplace: () -> Void
    let onDismiss: () -> Void
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .trailing) {
                if hovering {
                    HStack(spacing: 6) {
                        if canReplace {
                            Button(action: onReplace) {
                                Image(systemName: "arrow.2.squarepath")
                                    .font(.system(size: 9, weight: .bold))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .help("Replace")
                        }
                        Button(action: onDismiss) {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .bold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .help("Dismiss")
                    }
                    .padding(.trailing, 4)
                }
            }
            .onHover { hovering = $0 }
    }
}

/// File-group disclosure label: icon, path, a hover-revealed "replace all in
/// file" button, and the match-count badge.
private struct FileHeaderRow: View {
    let fm: FileMatch
    let badge: Int
    let canReplace: Bool
    let text: Color
    let muted: Color
    let surface: Color
    let onReplaceAll: () -> Void
    @State private var hovering = false

    var body: some View {
        let ext = fm.url.pathExtension
        return HStack(spacing: 6) {
            Image(systemName: FileIconKit.icon(for: ext))
                .font(.system(size: 11))
                .foregroundStyle(FileIconKit.color(for: ext))
                .frame(width: 16)
            Text(fm.displayPath)
                .font(Typography.captionStrong)
                .foregroundStyle(text)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if canReplace && hovering {
                Button(action: onReplaceAll) {
                    Image(systemName: "arrow.2.squarepath")
                        .font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Replace all in file")
            }
            Text("\(badge)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(muted)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(surface)
                .clipShape(Capsule())
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}
