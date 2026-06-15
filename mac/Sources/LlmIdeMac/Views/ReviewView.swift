import SwiftUI

// MARK: - ReviewConfig

struct ReviewConfig {
    let treeTitle: String
    let treeCategories: [LibraryItem.Category]
    let treeLabel: String
    let emptyIcon: String
    let emptyTitle: String
    let emptyHint: String
    let emptyHintWidth: CGFloat

    static let code = ReviewConfig(
        treeTitle: "EXPLORER",
        treeCategories: [.code],
        treeLabel: "Explorer",
        emptyIcon: "curlybraces",
        emptyTitle: "Select a file to view",
        emptyHint: "Clone a GitLab repo in Settings, or use **Add file / Add folder** in the tree",
        emptyHintWidth: 300
    )

    static let docs = ReviewConfig(
        treeTitle: "DOCUMENTS",
        treeCategories: [.notes, .data],
        treeLabel: "Documents",
        emptyIcon: "doc.text.magnifyingglass",
        emptyTitle: "Select a document to view",
        emptyHint: "Import notes, reports, PDFs, or data files\nusing **Add file** or **Add folder** in the tree",
        emptyHintWidth: 300
    )

    static let conflicts = ReviewConfig(
        treeTitle: "CODE & NOTES",
        treeCategories: [.code, .notes],
        treeLabel: "Files",
        emptyIcon: "exclamationmark.triangle",
        emptyTitle: "Select a file to view",
        emptyHint: "Import code or notes, then ask the assistant to compare them\nand flag conflicts or undecided items.",
        emptyHintWidth: 320
    )
}

// MARK: - ReviewView

struct ReviewView: View {
    let api: LlmIdeAPIClient
    let config: ReviewConfig

    @EnvironmentObject private var appConfig: AppConfig
    @EnvironmentObject private var theme: ThemeStore
    @Environment(LibraryItemStore.self) private var itemStore

    // Tree selection drives tab opening
    @State private var treeSelectedURL: URL?
    // Tab state
    @State private var openTabs: [URL] = []
    @State private var activeTabURL: URL?

    @State private var treeVisible = true
    @State private var assistantVisible = true

    /// Persists the user's chosen Code Assistant panel width across
    /// launches. HSplitView doesn't expose a width binding, so we read
    /// the rendered width via a GeometryReader background and write
    /// back here (see CodeAssistantPanel frame below).
    /// Default chat-panel width targets roughly a quarter of a typical
    /// Mac window (≈1280pt). Users can still drag wider; the chosen
    /// width persists across launches.
    @AppStorage("MEETNOTES_CHAT_PANEL_WIDTH") private var chatPanelWidth: Double = 200
    @State private var showWorkflowSheet = false
    @State private var showQuickFixSheet = false

    private var hasFile: Bool { activeTabURL != nil }

    /// GitLab-only: the active+cloned GitLab project. Drives the
    /// "New Change…" toolbar menu (workflows / MRs / issue linking).
    /// Stays GitLab-only because the write workflow is GitLab-typed.
    private var linkedProject: SavedGitLabProject? {
        guard config.treeCategories.contains(.code) else { return nil }
        return appConfig.gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned })
    }

    /// Backend-agnostic: the active+cloned repo from either GitLab OR
    /// GitHub. Used for the linked-repo banner and file-tree sync — both
    /// work the same whether the clone came from GitLab or GitHub.
    private var linkedCodeRepo: LinkedCodeRepo? {
        guard config.treeCategories.contains(.code) else { return nil }
        if let p = appConfig.gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned }),
           let url = p.localURL {
            return LinkedCodeRepo(displayName: p.displayName, localURL: url, backend: .gitlab)
        }
        if let r = appConfig.gitHubSavedRepos.first(where: { $0.isActive && $0.isCloned }),
           let url = r.localURL {
            return LinkedCodeRepo(displayName: r.displayName, localURL: url, backend: .github)
        }
        return nil
    }

    struct LinkedCodeRepo: Equatable {
        let displayName: String
        let localURL: URL
        let backend: RepoBackendKind
    }

    /// Banner copy when no repo is linked. Points the user at whichever
    /// Settings panel they've already configured (or both if neither —
    /// happens on a clean install).
    private var emptyRepoHint: String {
        let hasGitLab = !appConfig.gitLabToken.isEmpty
        let hasGitHub = !appConfig.gitHubToken.isEmpty
        switch (hasGitLab, hasGitHub) {
        case (true, true):
            return "No cloned repo linked — clone one in **Settings → GitLab** or **Settings → GitHub** and mark it Active."
        case (true, false):
            return "No cloned repo linked — clone in **Settings → GitLab**."
        case (false, true):
            return "No cloned repo linked — clone in **Settings → GitHub**."
        case (false, false):
            return "No cloned repo linked — connect **GitLab** or **GitHub** in Settings to begin."
        }
    }

    var body: some View {
        HSplitView {
            if treeVisible {
                FileTreePanel(title: config.treeTitle,
                              categories: config.treeCategories,
                              selectedURL: $treeSelectedURL)
                    .frame(minWidth: 200, idealWidth: 240, maxWidth: 300)
                    .transition(.move(edge: .leading))
            }

            VStack(spacing: 0) {
                if !openTabs.isEmpty {
                    EditorTabBar(tabs: $openTabs, activeTab: $activeTabURL)
                    Divider()
                }
                fileViewer
            }
            // Editor column. Used to cap at 220pt when no file was open,
            // which forced the chat panel to swallow all remaining
            // width regardless of the user's chosen chatPanelWidth.
            // Now it grows freely so the user can drag the divider
            // anywhere they like.
            .frame(minWidth: hasFile ? 340 : 160,
                   idealWidth: hasFile ? 460 : 180,
                   maxWidth: .infinity)

            if assistantVisible {
                CodeAssistantPanel(api: api,
                                   initialURL: activeTabURL,
                                   showFileAttachButtons: false,
                                   showModelPicker: true)
                    .frame(minWidth: 120,
                           idealWidth: CGFloat(chatPanelWidth),
                           maxWidth: .infinity)
                    .background(
                        // HSplitView doesn't bind back the actual width
                        // when the user drags the divider. Observing
                        // the rendered width through GeometryReader is
                        // the cleanest workaround — when the size
                        // settles after a drag, the new value is
                        // written back to AppStorage and applied on
                        // next launch.
                        GeometryReader { geo in
                            Color.clear
                                .onChange(of: geo.size.width) { _, w in
                                    let clamped = max(120, Double(w))
                                    if abs(clamped - chatPanelWidth) > 1 {
                                        chatPanelWidth = clamped
                                    }
                                }
                        }
                    )
                    .transition(.move(edge: .trailing))
            }
        }
        // One-time migration to the smaller default. Anything wider
        // than ~300pt left over from previous sessions snaps to 200pt
        // so users see the new compact default; manual drag-wider is
        // still respected on subsequent launches.
        .onAppear {
            if chatPanelWidth > 300 {
                chatPanelWidth = 200
            }
        }
        // Open a tab whenever the tree selection changes
        .onChange(of: treeSelectedURL) { _, url in
            guard let url else { return }
            if !openTabs.contains(url) { openTabs.append(url) }
            activeTabURL = url
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { treeVisible.toggle() }
                } label: {
                    Image(systemName: "sidebar.left")
                        .symbolVariant(treeVisible ? .fill : .none)
                }
                .help(treeVisible ? "Hide \(config.treeLabel)" : "Show \(config.treeLabel)")
            }

            if let project = linkedProject {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            showQuickFixSheet = true
                        } label: {
                            Label("Quick Fix", systemImage: "bolt.fill")
                        }
                        .help("Single-screen end-to-end fix for an existing issue")
                        Button {
                            showWorkflowSheet = true
                        } label: {
                            Label("Guided", systemImage: "list.bullet.rectangle")
                        }
                        .help("Step-by-step: create issue → branch → generate → review → MR")
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.triangle.branch")
                            Text("New Change…").font(Typography.button)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(theme.current.accent, in: RoundedRectangle(cornerRadius: 7))
                        .foregroundStyle(.white)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Quick Fix (one screen) or Guided (5 steps) — start a Code update")
                    .sheet(isPresented: $showWorkflowSheet) {
                        CodeWorkflowSheet(api: api, project: project)
                            .environmentObject(appConfig)
                    }
                    .sheet(isPresented: $showQuickFixSheet) {
                        QuickFixSheet(api: api, project: project)
                            .environmentObject(appConfig)
                    }
                }
            }

            ToolbarItem(placement: .primaryAction) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { assistantVisible.toggle() }
                } label: {
                    Image(systemName: "sidebar.right")
                        .symbolVariant(assistantVisible ? .fill : .none)
                }
                .help(assistantVisible ? "Hide Assistant" : "Show Assistant")
            }
        }
        .task(id: linkedCodeRepo?.localURL.path) { syncRepoToLibrary() }
    }

    // MARK: - Sync repo

    /// Adds the active+cloned repo (GitLab or GitHub) to the Library's
    /// CODE section so the file tree is populated automatically. The
    /// banner above the empty viewer reflects the same state.
    private func syncRepoToLibrary() {
        guard let repo = linkedCodeRepo else { return }
        let alreadyTracked = itemStore.items(for: .code)
            .contains(where: { $0.folderOrigin == repo.displayName || $0.url.path.hasPrefix(repo.localURL.path) })
        if !alreadyTracked { itemStore.addFolder(url: repo.localURL, category: .code) }
    }

    // MARK: - File viewer

    @ViewBuilder
    private var fileViewer: some View {
        if let url = activeTabURL {
            FileDetailView(url: url)
                .id(url)
        } else {
            VStack(spacing: 16) {
                if config.treeCategories.contains(.code) {
                    if let repo = linkedCodeRepo {
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.system(size: 12))
                            Text("Linked: **\(repo.displayName)** · \(repo.backend.displayName)")
                                .font(Typography.caption).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
                    } else {
                        // Tailor the hint to whichever backend(s) the user
                        // has configured so they don't get pointed at a
                        // setup path that's irrelevant to them.
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange).font(.system(size: 12))
                            Text(LocalizedStringKey(emptyRepoHint))
                                .font(Typography.caption).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
                Image(systemName: config.emptyIcon).font(.system(size: 40, weight: .thin)).foregroundStyle(.quaternary)
                Text(config.emptyTitle).font(Typography.emptyTitle).foregroundStyle(.tertiary)
                Text(LocalizedStringKey(config.emptyHint))
                    .font(Typography.emptyHint).foregroundStyle(.quaternary)
                    .multilineTextAlignment(.center).frame(maxWidth: config.emptyHintWidth)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.background)
        }
    }
}

// MARK: - EditorTabBar

struct EditorTabBar: View {
    @Binding var tabs: [URL]
    @Binding var activeTab: URL?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(tabs, id: \.self) { url in
                    EditorTab(
                        url: url,
                        isActive: activeTab == url,
                        onSelect: { activeTab = url },
                        onClose: { close(url) }
                    )
                }
            }
        }
        .frame(height: 35)
        .background(Color(NSColor.windowBackgroundColor))
    }

    private func close(_ url: URL) {
        guard let idx = tabs.firstIndex(of: url) else { return }
        tabs.remove(at: idx)
        if activeTab == url {
            if tabs.isEmpty { activeTab = nil }
            else { activeTab = tabs[min(idx, tabs.count - 1)] }
        }
    }
}

// MARK: - EditorTab

private struct EditorTab: View {
    let url: URL
    let isActive: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    @State private var isHovered = false
    @State private var closeHovered = false
    @EnvironmentObject private var theme: ThemeStore

    private var ext: String { url.pathExtension.lowercased() }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onSelect) {
                HStack(spacing: 5) {
                    Image(systemName: FileIconKit.icon(for: ext))
                        .font(.system(size: 11))
                        .foregroundStyle(FileIconKit.color(for: ext))
                        .frame(width: 14)
                    Text(url.lastPathComponent)
                        .font(Typography.filename)
                        .foregroundStyle(isActive ? .primary : .secondary)
                        .lineLimit(1)
                }
                .padding(.leading, 12)
                .padding(.trailing, 6)
                .frame(height: 35)
            }
            .buttonStyle(.plain)

            // Close button — always reserved; visible on hover or when active
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(closeHovered ? .primary : .secondary)
                    .frame(width: 16, height: 16)
                    .background(
                        closeHovered
                            ? Color(.separatorColor).opacity(0.5)
                            : Color.clear,
                        in: RoundedRectangle(cornerRadius: 3)
                    )
                    .opacity(isHovered || isActive ? 1 : 0)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 6)
            .onHover { closeHovered = $0 }

            // Right divider
            Divider().frame(height: 18)
        }
        .background(
            isActive
                ? Color(.textBackgroundColor)
                : (isHovered ? Color(.separatorColor).opacity(0.15) : Color.clear)
        )
        .overlay(alignment: .bottom) {
            if isActive {
                Rectangle()
                    .fill(theme.current.accent)
                    .frame(height: 2)
            }
        }
        .onHover { isHovered = $0 }
        .animation(.easeInOut(duration: 0.1), value: isHovered)
    }
}
