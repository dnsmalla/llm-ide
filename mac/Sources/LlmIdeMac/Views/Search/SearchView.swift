import SwiftUI

struct SearchView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore
    @State private var searchService = SearchService()
    @State private var query = ""
    @State private var results: [SearchService.FileMatch] = []
    @State private var searching = false
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?
    @State private var debounce: Task<Void, Never>?

    private var root: URL? {
        if let r = config.activeRepoLocalURL, FileManager.default.fileExists(atPath: r.path) { return r }
        if let p = projectStore.activeProject?.localPath { return URL(fileURLWithPath: p) }
        return nil
    }

    var body: some View {
        if root == nil {
            emptyState("Open a project or activate a repo to search")
        } else {
            HSplitView {
                resultsPane.frame(minWidth: 280, idealWidth: 340, maxWidth: 520)
                editorPane.frame(minWidth: 360)
            }
        }
    }

    private var resultsPane: some View {
        VStack(spacing: 0) {
            TextField("Search files by name or content", text: $query)
                .textFieldStyle(.plain).padding(8)
                .background(theme.current.surface2).clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                .padding(8)
                .onChange(of: query) { _, q in scheduleSearch(q) }
            Divider()
            if searching { ProgressView().padding() }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(results) { fm in
                        fileGroup(fm)
                    }
                }
            }
            if !query.isEmpty && results.isEmpty && !searching {
                Text("No matches").font(Typography.caption).foregroundStyle(theme.current.textMuted).padding()
            }
        }
    }

    @ViewBuilder private func fileGroup(_ fm: SearchService.FileMatch) -> some View {
        Text(fm.displayPath).font(Typography.captionStrong).foregroundStyle(theme.current.text)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onTapGesture { open(fm.url) }
        ForEach(fm.lines, id: \.self) { lm in
            HStack(spacing: 6) {
                Text("\(lm.line)").font(.system(size: 10, design: .monospaced)).foregroundStyle(theme.current.textMuted).frame(width: 36, alignment: .trailing)
                Text(lm.text).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.current.text).lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 1)
            .contentShape(Rectangle()).onTapGesture { open(fm.url) }
        }
    }

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

    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }

    private func scheduleSearch(_ q: String) {
        debounce?.cancel()
        guard let root else { results = []; return }
        debounce = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            searching = true
            let r = await searchService.search(query: q, root: root)
            if Task.isCancelled { return }
            results = r; searching = false
        }
    }
}
