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

    // (ReviewConfig.code removed with the .review section — Explorer now
    // owns the project file-browser role. ReviewView serves .docs and
    // .conflicts only.)

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
    /// Chat open-state is persisted (default open) so the assistant reads as
    /// the primary surface — same pattern as Explorer / Visual / DocGen. A
    /// manual close sticks across launches.
    @AppStorage("REVIEW_CHAT_VISIBLE") private var chatVisible = true

    /// Persists the user's chosen Code Assistant panel width across
    /// launches. HSplitView doesn't expose a width binding, so we read
    /// the rendered width via a GeometryReader background and write
    /// back here (see CodeAssistantPanel frame below).
    /// Default chat-panel width targets roughly a quarter of a typical
    /// Mac window (≈1280pt). Users can still drag wider; the chosen
    /// width persists across launches.
    @AppStorage("REVIEW_CHAT_PANEL_WIDTH") private var chatPanelWidth: Double = 180
    @State private var showWorkflowSheet = false
    @State private var showQuickFixSheet = false

    private var hasFile: Bool { activeTabURL != nil }

    /// GitLab-only: the active+cloned GitLab project. Drives the
    /// "New Change…" toolbar menu (workflows / MRs / issue linking).
    /// Stays GitLab-only because the write workflow is GitLab-typed.
    /// Backend-neutral target for the New Change menu — active+cloned GitLab
    /// or GitHub repo (GitLab first), or nil when none is linked.
    private var linkedWorkflowTarget: CodeWorkflowTarget? {
        guard config.treeCategories.contains(.code) else { return nil }
        return CodeWorkflowTarget.resolveActive(config: appConfig)
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
        VStack(spacing: 0) {
            reviewChromeBar
            Divider()
            // Fixed-width tree column outside HSplitView — HSplitView doesn't
            // reliably cap a leading child's width, so pin it here and let
            // HSplitView drive only the viewer ↔ chat split.
            HStack(spacing: 0) {
            if treeVisible {
                FileTreePanel(title: config.treeTitle,
                              categories: config.treeCategories,
                              selectedURL: $treeSelectedURL)
                    .frame(width: 240)
                    .transition(.move(edge: .leading))
                Divider()
            }

            HSplitView {
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

            if chatVisible {
                CodeAssistantPanel(api: api,
                                   scope: .conflicts,
                                   initialURL: activeTabURL,
                                   showFileAttachButtons: true,
                                   showModelPicker: true)
                    .persistedPanelWidth($chatPanelWidth, minWidth: 180, floor: 220)
                    .transition(.move(edge: .trailing))
            }
            }
        }
        .firstLaunchOpenChat(flagKey: "DID_AUTO_OPEN_REVIEW_CHAT_V1",
                             width: $chatPanelWidth, visible: $chatVisible)
        // Open a tab whenever the tree selection changes
        .onChange(of: treeSelectedURL) { _, url in
            guard let url else { return }
            if !openTabs.contains(url) { openTabs.append(url) }
            activeTabURL = url
        }
        .task(id: linkedCodeRepo?.localURL.path) { syncRepoToLibrary() }
        }
    }

    // MARK: - Inline section chrome (tree toggle · New Change · chat toggle)

    @ViewBuilder
    private var reviewChromeBar: some View {
        SectionChromeBar(toggles: [
            SectionToggle(icon: "sidebar.left", isOn: treeVisible,
                          helpOn: "Hide \(config.treeLabel)", helpOff: "Show \(config.treeLabel)") {
                withAnimation(.easeInOut(duration: 0.2)) { treeVisible.toggle() }
            }
        ]) {
            HStack(spacing: 8) {
                if let target = linkedWorkflowTarget { newChangeMenu(target) }
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { chatVisible.toggle() }
                } label: {
                    Image(systemName: "sidebar.right").symbolVariant(chatVisible ? .fill : .none)
                }
                .buttonStyle(.borderless)
                .help(chatVisible ? "Hide Chat" : "Show Chat")
            }
        }
    }

    private func newChangeMenu(_ target: CodeWorkflowTarget) -> some View {
        Menu {
            Button { showQuickFixSheet = true } label: {
                Label("Quick Fix", systemImage: "bolt.fill")
            }
            Button { showWorkflowSheet = true } label: {
                Label("Guided", systemImage: "list.bullet.rectangle")
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                Text("New Change…").font(Typography.button)
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(theme.current.accent, in: RoundedRectangle(cornerRadius: 7))
            .foregroundStyle(.white)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Quick Fix (one screen) or Guided (5 steps) — start a Code update")
        .sheet(isPresented: $showWorkflowSheet) {
            CodeWorkflowSheet(api: api, target: target).environmentObject(appConfig)
        }
        .sheet(isPresented: $showQuickFixSheet) {
            QuickFixSheet(api: api, target: target).environmentObject(appConfig)
        }
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
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.current.success).font(.system(size: 12))
                            Text("Linked: **\(repo.displayName)** · \(repo.backend.displayName)")
                                .font(Typography.caption).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(theme.current.success.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
                    } else {
                        // Tailor the hint to whichever backend(s) the user
                        // has configured so they don't get pointed at a
                        // setup path that's irrelevant to them.
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.circle").foregroundStyle(theme.current.warning).font(.system(size: 12))
                            Text(LocalizedStringKey(emptyRepoHint))
                                .font(Typography.caption).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(theme.current.warning.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
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
