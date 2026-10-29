import SwiftUI
import AppKit

/// Everything the Library sidebar's Plugins, LLM Sources and MCP Plugins
/// sections show and do: the lists, their load generations, the sheets' flags,
/// and the install / update / consent / remove actions. Held by `LibraryView`
/// as an opaque `ExtensionsLibraryHost` (it only ever asks for `refresh()`);
/// the section views and the lifecycle view in this folder render from it.
///
/// Moved verbatim out of `LibraryView` when plugins / MCP / LLM sources became
/// the Extensions feature — the code is the same, only its owner changed.
@MainActor
@Observable
final class ExtensionsLibraryModel: ExtensionsLibraryHost {
    let api: LlmIdeAPIClient
    let shell: ShellState
    let backend: BackendManager

    init(api: LlmIdeAPIClient, shell: ShellState, backend: BackendManager) {
        self.api = api
        self.shell = shell
        self.backend = backend
    }

    /// Installed plugins for the current user. Loaded once on appear
    /// and refreshed when the user (re-)opens Library. Failures are
    /// silent — the sidebar just shows an empty Plugins section.
    var plugins: [PluginInfo] = []
    /// Why the plugin list could not be read (server down, …). Without it a failed
    /// fetch read as "No plugins installed yet" and emptied the list.
    var pluginsError: String?
    /// True once a plugin list has loaded, so an empty `plugins` before that
    /// is never handed to the update center as "nothing installed".
    var pluginsLoaded = false
    /// The destructive action waiting for the user's yes.
    var pendingRemoval: ExtensionRemoval?
    /// An MCP consent waiting for the user's yes — the row's Consent button
    /// shows what would run before granting it.
    var pendingMcpConsent: McpConsentPrompt?
    /// Request tokens so an older list response cannot overwrite a newer one.
    @ObservationIgnored var loadGenerations = LibraryLoadGenerations()
    var showingGitInstallSheet = false
    var showingClaudeImportSheet = false
    var showingMarketplaceSheet = false
    var showingCodexImportSheet = false
    var pluginInstallMessage: String?
    /// Plugin-update state lives in an app-lifetime object, not here: this
    /// model dies on every section switch, and an update (or its
    /// confirmation, or its result) must not die with it.
    var updateCenter: PluginUpdateCenter { .shared }
    var pluginUpdates: [PluginUpdateEntry] { updateCenter.entries }
    /// Held when an install hits "already installed" (409): re-runs the same
    /// install with replace=true if the user confirms. Replaces the old
    /// "go to Settings → Plugins to overwrite" punt now that management is
    /// wholly in Library.
    var pendingReplaceInstall: ((Bool) async throws -> PluginInstallResponse)?
    /// Registered LLM sources for the current user. Loaded once on
    /// appear and refreshed after any add/toggle/update/remove — same
    /// pattern as `plugins`.
    var llmSources: [LlmIdeAPIClient.LlmSourceInfo] = []
    /// Upstream status per source id (`GET …/updates`) — drives the sidebar's
    /// "update" badge. Empty until the first check returns; never an error.
    var llmSourceUpdates: [String: LlmIdeAPIClient.LlmSourceUpdateStatus] = [:]
    var showingLlmSourceAddSheet = false
    var llmSourceMessage: String?
    /// Registered MCP plugins for the current user. Loaded once on appear
    /// and refreshed after any add/consent/toggle/remove — same pattern as
    /// `llmSources`, except load/refresh surface errors instead of
    /// swallowing them: an empty section from a real fetch failure (e.g. the
    /// server down) looks identical to "nothing registered yet" otherwise,
    /// which hides an actionable problem from the user.
    var mcpPlugins: [LlmIdeAPIClient.McpPluginInfo] = []
    var mcpPluginsError: String?
    /// Registry-owned (not view state) so a check outlives a section switch.
    let mcpUpdateCenter = McpUpdateCenter.shared
    var mcpPluginMessage: String?
    var mcpClaudeSources: [LlmIdeAPIClient.ClaudeMcpSource] = []
    var mcpCodexSources: [LlmIdeAPIClient.CodexMcpSource] = []
    /// Curated one-click servers. Loaded alongside the plugin list, because
    /// importing from a CLI config was the ONLY way in before this — and for
    /// anyone who had configured nothing, that meant no way in at all.
    var mcpCatalog: [LlmIdeAPIClient.McpCatalogEntry] = []
    var mcpAddSheet: McpAddSheet.Mode?
    // Non-nil when the initial LLM-sources fetch failed — distinguishes a real
    // load error from "user has zero sources" so the section doesn't misleadingly
    // show the empty placeholder on a network/auth/decode failure.
    var llmSourcesError: String?

    /// The search bar's refresh button: the same loaders the first appearance
    /// runs, in the order Library's refresh always ran them.
    func refresh() async {
        await loadPlugins()
        await loadLlmSources()
        await loadMcpPlugins()
    }

    /// Run the removal the user just confirmed.
    func perform(_ removal: ExtensionRemoval) async {
        switch removal {
        case .plugin(let name, _): await uninstall(name: name)
        case .mcpServer(let id, _): await removePlugin(id)
        case .llmSource(let id, _): await removeSource(id)
        }
    }

    // MARK: - Plugins

    /// Load installed plugins for the Library → Plugins section. A failure keeps
    /// the last good list and says so, rather than emptying it.
    func loadPlugins() async {
        let token = loadGenerations.begin(.plugins)
        do {
            let fetched = try await api.listPlugins().plugins
            guard loadGenerations.isCurrent(token, for: .plugins) else { return }
            self.plugins = fetched
            self.pluginsError = nil
            self.pluginsLoaded = true
        } catch {
            guard loadGenerations.isCurrent(token, for: .plugins) else { return }
            self.pluginsError = error.localizedDescription
        }
    }

    /// the cached update check is stale too (a removed plugin's badge must go).
    func refreshPlugins() async {
        await loadPlugins()
        updateCenter.invalidateCheck()
        await loadPluginUpdates()
    }

    /// True when the server has the one-click update endpoint (API v60+).
    var usesOneClickUpdate: Bool {
        PluginUpdatePresentation.supportsOneClickUpdate(serverApiVersion: backend.serverApiVersion)
    }

    /// Ask both bridges what the vendor sources now offer (the center keeps a
    /// short TTL for non-forced checks). `force` also refreshes the
    /// marketplace catalogs server-side (v60+ only).
    func loadPluginUpdates(force: Bool = false) async {
        updateCenter.supportsExpect = PluginUpdatePresentation.supportsExpect(
            serverApiVersion: backend.serverApiVersion)
        // The full list lets the center route each update by its install
        // source; nil (nothing loaded yet) keeps what it already knows. After a
        // failed reload `plugins` is still the last good list.
        await updateCenter.refresh(api: api, oneClick: usesOneClickUpdate, force: force,
                                   plugins: pluginsLoaded ? plugins : nil)
    }

    /// Move a result the center holds for the Library into this view's alert.
    func consumeUpdateMessage() {
        guard let message = updateCenter.libraryMessage else { return }
        updateCenter.libraryMessage = nil
        pluginInstallMessage = message
    }

    /// Re-scan the vendors' own plugin directories, then re-check. This is the
    /// only way a plugin added to Claude Code *after* llm-ide started becomes
    /// visible without a restart.
    func rescanVendorSources() async {
        let claude = try? await api.refreshClaudeSources()
        let codex = try? await api.refreshCodexSources()
        // An explicit check: refresh the marketplace catalogs too.
        await loadPluginUpdates(force: true)
        await scanClaudeSources()
        await scanCodexSources()
        // Split out of the message expression: inlining these sums plus two
        // nested interpolations defeated the type-checker's time budget.
        let claudeSeen: Int = (claude?.installed ?? 0) + (claude?.marketplace ?? 0)
        let codexSeen: Int = (codex?.installed ?? 0) + (codex?.marketplace ?? 0)
        let seen: Int = claudeSeen + codexSeen
        let pendingCount: Int = pluginUpdates.count
        if pendingCount == 0 {
            let plural: String = seen == 1 ? "" : "s"
            pluginInstallMessage = "Re-scanned \(seen) vendor plugin\(plural). Everything imported is up to date."
        } else {
            let plural: String = pendingCount == 1 ? "" : "s"
            pluginInstallMessage = "\(pendingCount) update\(plural) available."
        }
    }

    /// Synchronous on purpose: the center marks itself running before this
    /// returns, so a second click is refused instead of starting a second run.
    func applyPluginUpdate(_ update: PluginUpdateEntry) {
        updateCenter.startUpdate(name: update.name, api: api, oneClick: usesOneClickUpdate, origin: .library)
    }

    func applyAllPluginUpdates() {
        updateCenter.startUpdateAll(api: api, oneClick: usesOneClickUpdate)
    }

    func reloadPlugins() async {
        _ = try? await api.reloadPlugins()
        await refreshPlugins()
    }

    func revealPluginsFolder() {
        Task {
            if let resp = try? await api.listPlugins() {
                let url = URL(fileURLWithPath: resp.pluginDir, isDirectory: true)
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
        }
    }

    func installFromZip() async {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a plugin .zip"
        panel.prompt = "Install"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        // Only the file name is recorded: a local path is neither portable nor
        // something an update check could use.
        let source = PluginInstallSource.zip(fileName: url.lastPathComponent)
        await performInstall { replace in
            try await self.api.installPlugin(zipURL: url, replace: replace, source: source)
        }
    }

    func installFromGit(url: String, ref: String?) async {
        await performInstall { replace in
            try await self.api.installPluginFromGit(url: url, ref: ref, replace: replace)
        }
    }

    /// Common install plumbing: run the install closure, surface
    /// success/failure via the alert, and refresh the sidebar list. On 409
    /// (already installed) it holds the op so the "Plugin already installed"
    /// alert can re-run it with replace=true — the in-Library replacement for
    /// the old "overwrite from Settings → Plugins" flow.
    func performInstall(_ op: @escaping (_ replace: Bool) async throws -> PluginInstallResponse) async {
        do {
            let resp = try await op(false)
            pluginInstallMessage = "Installed \(resp.plugin.title) v\(resp.plugin.version)."
            await refreshPlugins()
        } catch let APIError.http(status, _, message, _) where status == 409 || message.contains("already installed") {
            // The server answers 409 with code INSTALL_FAILED; the status is the
            // signal, the message a fallback for a proxy that rewrites it.
            pendingReplaceInstall = op
        } catch {
            pluginInstallMessage = error.localizedDescription
        }
    }

    /// Re-run the held install with replace=true after the user confirms.
    func replaceInstall(_ op: ((Bool) async throws -> PluginInstallResponse)?) async {
        guard let op else { return }
        do {
            let resp = try await op(true)
            pluginInstallMessage = PluginUpdatePresentation.replacedMessage(
                name: resp.plugin.title, version: resp.plugin.version,
                trustReset: resp.plugin.trustReset == true)
            await refreshPlugins()
        } catch {
            pluginInstallMessage = error.localizedDescription
        }
    }

    /// By NAME: the server needs nothing else, and a lookup in `plugins` made a
    /// confirmed uninstall silently do nothing when the list had refreshed while
    /// the dialog was open.
    func uninstall(name: String) async {
        do {
            _ = try await api.uninstallPlugin(name: name)
            if case .plugin(let selected) = shell.librarySelection, selected == name {
                shell.librarySelection = nil
            }
            await refreshPlugins()
        } catch {
            pluginInstallMessage = error.localizedDescription
        }
    }

    // MARK: - LLM sources

    /// Load registered LLM sources for the Library section. A failure sets
    /// `llmSourcesError` so the section shows the real error (with Retry)
    /// instead of misleadingly rendering the empty placeholder.
    func loadLlmSources() async {
        let token = loadGenerations.begin(.llmSources)
        do {
            let fetched = try await api.listLlmSources()
            guard loadGenerations.isCurrent(token, for: .llmSources) else { return }
            llmSources = fetched
            llmSourcesError = nil
        } catch {
            guard loadGenerations.isCurrent(token, for: .llmSources) else { return }
            llmSources = []
            llmSourcesError = error.localizedDescription
        }
    }

    /// Best-effort: a failed check leaves the previous badges in place.
    func loadLlmSourceUpdates(force: Bool) async {
        guard let statuses = try? await api.llmSourceUpdates(force: force) else { return }
        llmSourceUpdates = Dictionary(statuses.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        if force {
            let n = statuses.filter(\.updateAvailable).count
            llmSourceMessage = n == 0 ? "All LLM sources are up to date."
                : "\(n) LLM source\(n == 1 ? " has an update" : "s have updates") — open it and press Update."
        }
    }

    func refreshLlmSources() async {
        // Same list as `loadLlmSources`, so the same generation: whichever of
        // the two started last owns the rows.
        let token = loadGenerations.begin(.llmSources)
        do {
            let fetched = try await api.listLlmSources()
            guard loadGenerations.isCurrent(token, for: .llmSources) else { return }
            llmSources = fetched
            llmSourcesError = nil
        } catch {
            guard loadGenerations.isCurrent(token, for: .llmSources) else { return }
            llmSourcesError = error.localizedDescription
        }
    }

    func toggleSource(_ id: String, enabled: Bool) async {
        do {
            _ = try await api.toggleLlmSource(id: id, enabled: enabled)
            await refreshLlmSources()
        } catch {
            llmSourceMessage = error.localizedDescription
        }
    }

    func addSource(url: String?, path: String?, ref: String?, name: String?) async {
        do {
            let added = try await api.addLlmSource(url: url, path: path, ref: ref, name: name)
            llmSourceMessage = "Added \(added.name)."
            await refreshLlmSources()
        } catch {
            llmSourceMessage = error.localizedDescription
        }
    }

    func removeSource(_ id: String) async {
        do {
            try await api.removeLlmSource(id: id)
            if case .llmSource(let sel) = shell.librarySelection, sel == id {
                shell.librarySelection = nil
            }
            await refreshLlmSources()
        } catch {
            llmSourceMessage = error.localizedDescription
        }
    }

    // MARK: - MCP plugins

    func loadMcpPlugins() async {
        let token = loadGenerations.begin(.mcpPlugins)
        do {
            let fetched = try await api.listMcpPlugins()
            guard loadGenerations.isCurrent(token, for: .mcpPlugins) else { return }
            mcpPlugins = fetched
            mcpPluginsError = nil
        } catch {
            guard loadGenerations.isCurrent(token, for: .mcpPlugins) else { return }
            mcpPluginsError = error.localizedDescription
        }
        // Best-effort: a catalog fetch failure just leaves the submenu empty
        // rather than reporting an error over the plugin list, which is the
        // more important thing on this screen.
        let catalog = try? await api.fetchMcpCatalog()
        guard loadGenerations.isCurrent(token, for: .mcpPlugins) else { return }
        mcpCatalog = catalog ?? mcpCatalog
        // Version badges (API v62+): cached server-side, so cheap to repeat.
        if McpUpdatePresentation.isSupported(serverApiVersion: backend.serverApiVersion),
           mcpPlugins.contains(where: { $0.package != nil }) {
            // Not awaited: a slow registry must not hold up the list loads.
            mcpUpdateCenter.startListCheck(api: api)
        }
    }

    /// One add call for every entry point — the server resolves catalogId,
    /// claudeName/codexName, or a raw command/url, so the client never has to
    /// restate what the catalog already knows.
    func addMcpPlugin(catalogId: String?, arg: String?, name: String?,
                              transport: String?, command: String?, args: [String]?, url: String?) async {
        do {
            let added = try await api.addMcpPlugin(
                catalogId: catalogId, arg: arg, command: command, args: args,
                url: url, transport: transport, name: name)
            mcpPluginMessage = "Added \(added.name). Consent and enable it to start using it."
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    func refreshMcpPlugins() async { await loadMcpPlugins() }

    /// Read-only scan, available to every authenticated user (the server
    /// dropped its admin gate — LLM-IDE has no admin concept). A transport
    /// failure is swallowed: the submenu just stays empty until a Rescan.
    func scanClaudeSources() async {
        mcpClaudeSources = (try? await api.scanClaudeMcpSources()) ?? []
    }

    func addPluginFromClaude(_ claudeName: String) async {
        do {
            let added = try await api.addMcpPlugin(claudeName: claudeName)
            mcpPluginMessage = "Added \(added.name)."
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    /// Read-only scan, available to every authenticated user (the server
    /// dropped its admin gate — LLM-IDE has no admin concept). A transport
    /// failure is swallowed: the submenu just stays empty until a Rescan.
    func scanCodexSources() async {
        mcpCodexSources = (try? await api.scanCodexMcpSources()) ?? []
    }

    func addPluginFromCodex(_ codexName: String) async {
        do {
            let added = try await api.addMcpPlugin(codexName: codexName)
            mcpPluginMessage = "Added \(added.name)."
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    func consentPlugin(_ id: String, consented: Bool) async {
        do {
            _ = try await api.consentMcpPlugin(id: id, consented: consented)
            await refreshMcpPlugins()
            notifyOpenMcpPane(id)
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    func togglePlugin(_ id: String, enabled: Bool) async {
        do {
            _ = try await api.toggleMcpPlugin(id: id, enabled: enabled)
            await refreshMcpPlugins()
            notifyOpenMcpPane(id)
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    /// An open detail pane for THIS server would otherwise keep showing the old
    /// switch. Bumping the token reloads every Library section, so it is done only
    /// when that pane is actually open — not on every sidebar click.
    func notifyOpenMcpPane(_ id: String) {
        if case .mcpPlugin(let selected) = shell.librarySelection, selected == id {
            shell.markLibraryDirty()
        }
    }

    func removePlugin(_ id: String) async {
        do {
            try await api.removeMcpPlugin(id: id)
            if case .mcpPlugin(let sel) = shell.librarySelection, sel == id {
                shell.librarySelection = nil
            }
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    // MARK: - Removal confirmation

    /// Presents the confirmation only for the kind the calling section owns,
    /// so three sections can each carry a dialog off one `pendingRemoval`
    /// without two of them presenting at once.
    func removalBinding(_ matches: @escaping (ExtensionRemoval) -> Bool) -> Binding<Bool> {
        Binding(
            get: { self.pendingRemoval.map(matches) ?? false },
            set: { if !$0 { self.pendingRemoval = nil } }
        )
    }

    @ViewBuilder
    func removalButtons(_ removal: ExtensionRemoval) -> some View {
        Button(removal.confirmLabel, role: .destructive) {
            self.pendingRemoval = nil
            Task { await self.perform(removal) }
        }
        Button("Cancel", role: .cancel) { self.pendingRemoval = nil }
    }
}
