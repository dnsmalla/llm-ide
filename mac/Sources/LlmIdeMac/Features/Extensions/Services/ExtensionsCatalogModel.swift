import Foundation

/// State and actions of the Extensions catalog screen (Installed / Browse /
/// Install). Every network step (install, update check, preview, apply,
/// refresh, repair) runs only from a user action; appearing reads the server's
/// cached lists only (`installed`, `catalog`).
@MainActor
@Observable
final class ExtensionsCatalogModel {
    /// A consent the user has to give before an item is switched on or updated.
    struct ConsentRequest: Identifiable, Equatable {
        enum Purpose: Equatable { case enable, update(commit: String) }
        let itemId: String
        let itemName: String
        let commit: String
        let purpose: Purpose
        let lines: [ExtConsentLine]
        var id: String { "\(itemId)|\(commit)|\(purpose)" }
        var kinds: [String] { lines.map(\.kind) }
    }

    struct PreviewState: Identifiable, Equatable {
        let item: ExtInstalledItem
        let preview: ExtUpdatePreview
        var id: String { item.id }
    }

    /// The one sheet showing now: a consent wins over a preview (apply turns the latter into the former).
    enum ActiveSheet: Identifiable, Equatable {
        case consent(ConsentRequest)
        case preview(PreviewState)
        var id: String {
            switch self {
            case .consent(let r): return "consent|" + r.id
            case .preview(let p): return "preview|" + p.id
            }
        }
    }

    var activeSheet: ActiveSheet? {
        if let r = pendingConsent { return .consent(r) }
        if let p = preview { return .preview(p) }
        return nil
    }

    func dismissSheet() {
        if pendingConsent != nil { pendingConsent = nil } else { preview = nil }
    }

    enum Tab: String, CaseIterable, Identifiable {
        case installed = "Installed"
        case browse = "Browse"
        case install = "Install"
        var id: String { rawValue }
    }

    private let api: any ExtensionsCatalogAPI

    init(api: any ExtensionsCatalogAPI) { self.api = api }

    var tab: Tab = .installed

    // Installed
    private(set) var items: [ExtInstalledItem] = []
    private(set) var corrupt = false
    private(set) var loaded = false
    private(set) var loading = false
    var loadError: String?
    /// Ids with a request in flight (their controls are disabled).
    private(set) var busy: Set<String> = []
    /// One result line for the last action (shown as a banner).
    var notice: String?
    var noticeIsError = false
    /// The server said the catalog is off (404 CATALOG_DISABLED).
    private(set) var catalogOff = false
    private(set) var checking = false

    var pendingConsent: ConsentRequest?
    var preview: PreviewState?
    var pendingRollback: ExtInstalledItem?
    var pendingUninstall: ExtInstalledItem?

    // Install
    var installURL = ""
    var installPath = ""
    var installing = false
    /// The item the last install produced, shown with its pinned commit and findings.
    private(set) var lastInstall: ExtInstallResult?
    var pendingBrowseInstall: ExtCatalogEntry?

    // Browse
    var query = ""
    var kindFilter: String?
    private(set) var page: ExtCatalogPage?
    private(set) var browseLoaded = false
    var browseError: String?
    private(set) var refreshing = false
    private var searchSeq = 0

    // MARK: Installed

    /// Reads the server's installed record (no network beyond localhost).
    func loadInstalled() async {
        loading = true
        defer { loading = false }
        do {
            let list = try await api.extInstalled()
            items = list.items
            corrupt = list.corrupt
            loadError = nil
            loaded = true
        } catch {
            loadError = ExtensionsCatalogPresentation.message(for: error)
        }
    }

    var groups: [(kind: String, items: [ExtInstalledItem])] { ExtensionsCatalogPresentation.grouped(items) }
    var updateCount: Int { items.filter(ExtensionsCatalogPresentation.hasUpdate).count }

    func item(_ id: String) -> ExtInstalledItem? { items.first { $0.id == id } }

    private func replace(_ item: ExtInstalledItem) {
        if let i = items.firstIndex(where: { $0.id == item.id }) { items[i] = item } else { items.append(item) }
    }

    private func fail(_ error: Error) {
        let code = ExtensionsCatalogPresentation.errorCode(error)
        if code == "CATALOG_DISABLED" { catalogOff = true }
        notice = ExtensionsCatalogPresentation.message(for: error)
        noticeIsError = true
    }

    private func succeed(_ text: String) {
        notice = text
        noticeIsError = false
    }

    /// Runs `work` with the item marked busy; one request per item at a time.
    /// A rejected call (the item is already busy) says so instead of doing nothing.
    @discardableResult
    private func withBusy(_ id: String, _ work: () async -> Void) async -> Bool {
        guard !busy.contains(id) else {
            notice = "Busy, try again."
            noticeIsError = true
            return false
        }
        busy.insert(id)
        defer { busy.remove(id) }
        await work()
        return true
    }

    // MARK: Enable / consent

    /// The switch was turned on: ask for consent when the item can run code,
    /// otherwise switch it on directly.
    func requestEnable(_ item: ExtInstalledItem) async {
        let kinds = ExtensionsCatalogPresentation.consentKinds(item)
        if kinds.isEmpty {
            await toggle(item, enabled: true, consents: nil)
            return
        }
        pendingConsent = ConsentRequest(
            itemId: item.id, itemName: item.name, commit: item.pinnedCommit, purpose: .enable,
            lines: ExtensionsCatalogPresentation.consentLines(kinds: kinds, members: item.members,
                                                              permissions: item.permissions))
    }

    func disable(_ item: ExtInstalledItem) async { await toggle(item, enabled: false, consents: nil) }

    private func toggle(_ item: ExtInstalledItem, enabled: Bool, consents: [String]?) async {
        await withBusy(item.id) {
            do {
                let r = try await api.extToggle(id: item.id, enabled: enabled, consents: consents)
                replace(r.item)
                succeed(enabled ? "\(item.name) is on." : "\(item.name) is off.")
            } catch { fail(error) }
        }
    }

    /// The user ticked every kind in the consent sheet and confirmed.
    func confirmConsent() async {
        guard let request = pendingConsent else { return }
        pendingConsent = nil
        guard let item = item(request.itemId) else {
            notice = "\(request.itemName) is no longer installed, so nothing was changed."
            noticeIsError = true
            return
        }
        switch request.purpose {
        case .enable:
            // The consent named the code at this commit; a different one needs its own consent.
            guard item.pinnedCommit == request.commit else {
                notice = "\(item.name) changed while you were deciding. Switch it on again to review it."
                noticeIsError = true
                return
            }
            await toggle(item, enabled: true, consents: request.kinds)
        case .update(let commit):
            await applyUpdate(item, commit: commit, consents: request.kinds)
        }
    }

    func setMember(_ item: ExtInstalledItem, memberId: String, checked: Bool) async {
        await withBusy(item.id) {
            do {
                let r = try await api.extToggleMembers(id: item.id, members: [memberId], enabled: checked)
                replace(r.item)
            } catch { fail(error) }
        }
    }

    // MARK: Install

    /// Installs from a GitHub URL the user typed. The server pins the commit
    /// and installs it switched off; nothing runs.
    func install() async {
        let url = installURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        let path = installPath.trimmingCharacters(in: .whitespacesAndNewlines)
        await runInstall(url: url, path: path.isEmpty ? nil : path)
    }

    /// True when the install succeeded (the Browse tab then moves to Install to show the result).
    @discardableResult
    func installFromCatalog(_ entry: ExtCatalogEntry) async -> Bool {
        pendingBrowseInstall = nil
        guard entry.installable, let url = entry.source.url else { return false }
        return await runInstall(url: url, path: entry.source.path)
    }

    @discardableResult
    private func runInstall(url: String, path: String?) async -> Bool {
        guard !installing else { return false }
        installing = true
        defer { installing = false }
        do {
            let r = try await api.extInstall(url: url, ref: nil, commit: nil, path: path)
            lastInstall = r
            replace(r.item)
            succeed(r.alreadyInstalled == true
                    ? "\(r.item.name) was already installed at this commit."
                    : "Installed \(r.item.name). It is off until you switch it on.")
            await loadBrowseAfterInstall()
            return true
        } catch {
            lastInstall = nil
            fail(error)
            return false
        }
    }

    private func loadBrowseAfterInstall() async {
        if browseLoaded { await search() }
    }

    func dismissLastInstall() { lastInstall = nil }

    // MARK: Uninstall

    func uninstall(_ item: ExtInstalledItem) async {
        pendingUninstall = nil
        await withBusy(item.id) {
            do {
                try await api.extUninstall(id: item.id)
                items.removeAll { $0.id == item.id }
                if lastInstall?.item.id == item.id { lastInstall = nil }
                succeed("Removed \(item.name) and its stored files.")
            } catch { fail(error); return }
            // The Browse list's "installed" badge came from the server before the removal.
            if browseLoaded { await search() }
        }
    }

    // MARK: Updates

    /// Asks GitHub for the newest commit of each installed item (or one).
    /// User-initiated: one GitHub call per item.
    func checkUpdates(for id: String? = nil) async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        do {
            let r = try await api.extCheckUpdates(id: id)
            await loadInstalled()
            let n = r.results.filter(\.updateAvailable).count
            let errors = r.results.filter { $0.error != nil }.count
            var text = n == 0 ? "Everything checked is up to date." : "\(n) update\(n == 1 ? "" : "s") available."
            if errors > 0 { text += " \(errors) could not be checked." }
            succeed(text)
        } catch { fail(error) }
    }

    /// Downloads the candidate in memory and shows what would change. Writes nothing.
    func openPreview(_ item: ExtInstalledItem, notice reviewNotice: String? = nil) async {
        await withBusy(item.id) {
            do {
                let p = try await api.extPreviewUpdate(id: item.id, commit: item.update?.latest)
                preview = PreviewState(item: item, preview: p)
                if let reviewNotice { succeed(reviewNotice) }
            } catch {
                if ExtensionsCatalogPresentation.errorCode(error) == "ALREADY_CURRENT" { await loadInstalled() }
                fail(error)
            }
        }
    }

    /// Apply was pressed in the preview sheet. A candidate that needs consent
    /// goes through the consent sheet first (it names what will run).
    func applyPreview() async {
        guard let state = preview else { return }
        let p = state.preview
        preview = nil
        if p.consent.required, !p.consent.kinds.isEmpty {
            pendingConsent = ConsentRequest(
                itemId: state.item.id, itemName: state.item.name, commit: p.to, purpose: .update(commit: p.to),
                lines: ExtensionsCatalogPresentation.consentLines(
                    kinds: p.consent.kinds,
                    members: p.executable.newMembers.map {
                        ExtInstalledItem.Member(memberId: $0.memberId, type: $0.type, name: $0.name, executable: true)
                    },
                    permissions: state.item.permissions))
            return
        }
        await applyUpdate(state.item, commit: p.to, consents: nil)
    }

    /// Always sends the commit the user previewed (and consented to), so the server refuses
    /// anything that moved since: UPDATE_CHANGED goes back to a fresh preview, ALREADY_CURRENT
    /// reloads the list.
    private func applyUpdate(_ item: ExtInstalledItem, commit: String, consents: [String]?) async {
        enum Follow { case repreview, reload }
        var follow: Follow?
        await withBusy(item.id) {
            do {
                let r = try await api.extApplyUpdate(id: item.id, commit: commit, consents: consents)
                replace(r.item)
                succeed(ExtensionsCatalogPresentation.updateOutcomeText(r.update, verb: "Updated"))
            } catch {
                switch ExtensionsCatalogPresentation.errorCode(error) {
                case "UPDATE_CHANGED": follow = .repreview
                case "ALREADY_CURRENT": follow = .reload
                default: fail(error)
                }
            }
        }
        switch follow {
        case .repreview:
            await loadInstalled()
            await openPreview(self.item(item.id) ?? item, notice: "That update changed; review it again.")
        case .reload:
            await loadInstalled()
            succeed("Already up to date.")
        case nil: break
        }
    }

    func rollback(_ item: ExtInstalledItem) async {
        pendingRollback = nil
        await withBusy(item.id) {
            do {
                let r = try await api.extRollback(id: item.id)
                replace(r.item)
                succeed(ExtensionsCatalogPresentation.updateOutcomeText(r.rollback, verb: "Rolled back"))
            } catch { fail(error) }
        }
    }

    func repair(_ item: ExtInstalledItem) async {
        await withBusy(item.id) {
            do {
                let r = try await api.extRepair(id: item.id)
                replace(r.item)
                succeed(ExtensionsCatalogPresentation.repairText(r))
            } catch { fail(error) }
        }
    }

    // MARK: Browse

    /// Reads the cached catalog (no network). Safe on appear.
    func search() async {
        searchSeq += 1
        let mine = searchSeq
        do {
            let result = try await api.extCatalog(query: query.trimmingCharacters(in: .whitespaces), kind: kindFilter,
                                                  limit: 50, offset: 0)
            guard mine == searchSeq else { return }  // a newer search superseded this one
            page = result
            browseError = nil
            browseLoaded = true
        } catch {
            guard mine == searchSeq else { return }
            browseError = ExtensionsCatalogPresentation.message(for: error)
            if ExtensionsCatalogPresentation.errorCode(error) == "CATALOG_DISABLED" { catalogOff = true }
        }
    }

    /// Fetches the four indexes from GitHub and the MCP registry. User-initiated.
    func refreshCatalog() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let r = try await api.extRefreshCatalog(source: nil)
            await search()
            succeed(ExtensionsCatalogPresentation.refreshSummary(r))
        } catch { fail(error) }
    }
}
