import Foundation
import Observation

/// App-lifetime owner of plugin-update state: the last check, the updates in
/// flight, a pending command confirmation and each plugin's last result.
///
/// It is NOT view state on purpose. AppShell's section `switch` + `AnyView`
/// destroys a section view's `@State`, so an update started from the Library
/// used to lose its result (and its confirmation) the moment the user switched
/// sections. Views read this object and route actions through it.
///
/// Shared like `GenerationRegistry.shared`: the Library sidebar, its detail
/// pane and the import sheet have no common owner below the Shell.
///
/// Sign-out (`SessionScoped`): every await is followed by an epoch check, and
/// work started under an older epoch writes NOTHING — no result, no message,
/// no confirmation — so the previous account's update never surfaces in (or
/// is accepted under) the next account's session.
@MainActor
@Observable
final class PluginUpdateCenter: SessionScoped {
    static let shared = PluginUpdateCenter()

    /// One plugin's last check / update result, as the detail pane shows it.
    struct Result: Equatable {
        let message: String
        let failed: Bool
    }

    /// Which surface asked, so only that surface presents the sheet.
    enum Origin: Equatable { case library, detail }

    /// Updates the last check reported (pre-v60 rows converted).
    private(set) var entries: [PluginUpdateEntry] = []
    /// A vendor check or a git / marketplace check is running.
    var checking: Bool { vendorChecking || sourceCheckRunning }
    private var vendorChecking = false
    /// A source check is out. A non-forced refresh does not start a second
    /// one meanwhile; it can take a minute per unreachable origin.
    private var sourceCheckRunning = false
    /// Bumped by every source check that starts (and on sign-out); only the
    /// newest one may write its results — independent of `refreshGeneration`,
    /// so a quick vendor refresh does not throw away a slow source answer.
    private var sourceGeneration = 0
    /// Plugins whose update is running.
    private(set) var inFlight: Set<String> = []
    /// True from the click until the update / batch ends — set synchronously
    /// by the `start…` entry points, so a double click cannot start two runs.
    private(set) var isRunning = false
    /// Settable so a sheet can bind to it; set to nil to dismiss.
    var pendingConfirmation: PluginUpdateConfirmation?
    private(set) var pendingOrigin: Origin = .library
    private(set) var results: [String: Result] = [:]
    /// What an "Update all" did before stopping for a confirmation.
    private(set) var deferredSummary: String?
    /// A message for the Library's alert; the Library consumes it (also on
    /// re-appear, so a result that landed while it was gone is still shown).
    /// Never "": `post(_:)` turns an empty message into nil.
    var libraryMessage: String?
    /// Bumped after any update that changed something, so the Library reloads
    /// its plugin list even when the surface that started it is gone.
    private(set) var changeToken = 0

    /// Non-forced checks within this window reuse the last answer.
    static let checkTTL: TimeInterval = 60
    /// Git / marketplace checks clone or ls-remote every source, so a plain
    /// Library refresh reuses their answer for this long; only a forced check
    /// ("Check for updates") goes out sooner.
    static let sourceCheckTTL: TimeInterval = 30 * 60
    private var lastCheck: (at: Date, oneClick: Bool)?
    private var lastSourceCheck: Date?
    /// The plugins the last source check covered (see `PluginUpdateSources.isDue`).
    private var sourceCheckedNames: Set<String> = []
    /// The gate the last refresh ran under; routing (and so the merge) needs it.
    private var lastOneClick = false
    /// Whether the server honours `?expect=` (API v61+); set by the views from
    /// `backend.serverApiVersion`. Below it the git / marketplace / file paths
    /// are off. Defaults to false: nil (not probed yet) counts as old.
    var supportsExpect = false {
        didSet { if oldValue != supportsExpect { rebuildEntries() } }
    }
    /// What the vendor bridges (Claude Code / Codex) reported last.
    private var vendorEntries: [PluginUpdateEntry] = []
    /// What the git / marketplace check reported last (tier "upstream").
    private var sourceEntries: [PluginUpdateEntry] = []
    /// Per-plugin reasons the last source check could not answer, as written
    /// into `results` (kept so a later success can clear exactly those).
    private var sourceFailures: [String: String] = [:]
    /// The installed plugins as the Library last listed them: routing needs
    /// each one's origin and install source, which update entries lack.
    private var knownPlugins: [String: PluginInfo] = [:]
    private let sourceChecker = PluginSourceUpdateChecker()
    /// Bumped on sign-out; work started under an older epoch reports nothing.
    private var epoch = 0
    /// Bumped by every refresh that actually fetches; only the newest one may
    /// write `entries` or clear `checking`.
    private var refreshGeneration = 0

    private init() {
        // Library may name Core; Core never names Library, so enroll here.
        SessionScopedRegistry.shared.register(self)
    }

    var isUpdating: Bool { isRunning || !inFlight.isEmpty }

    func entry(for name: String) -> PluginUpdateEntry? {
        entries.first { $0.name == name }
    }

    func resetForSignOut() {
        epoch += 1
        refreshGeneration += 1
        entries = []
        vendorEntries = []
        sourceEntries = []
        sourceFailures = [:]
        knownPlugins = [:]
        lastSourceCheck = nil
        sourceCheckedNames = []
        sourceGeneration += 1
        sourceCheckRunning = false
        vendorChecking = false
        inFlight = []
        isRunning = false
        pendingConfirmation = nil
        results = [:]
        deferredSummary = nil
        libraryMessage = nil
        lastCheck = nil
    }

    /// The detail pane's own fresh copy of one plugin: routing needs its
    /// install source even when the Library has not listed it yet (or its
    /// list predates a replace).
    func remember(_ info: PluginInfo) {
        knownPlugins[info.name] = info
    }

    /// Forget the last check, so the next non-forced refresh fetches. Called
    /// when the plugin set changed outside the center (import, remove, reload).
    func invalidateCheck() {
        lastCheck = nil
    }

    // MARK: - Check

    /// Ask both bridges what the vendor sources offer, and the git /
    /// marketplace origins whether they moved. Best-effort per vendor: a
    /// machine without Claude Code or Codex simply has no updates.
    ///
    /// Pre: `oneClick` is the v60 gate for the current server. `plugins`, when
    /// given, is the full installed list (it replaces what the center knows).
    /// Post: `entries` is fresh unless a non-forced check ran under `checkTTL`
    /// ago against the same gate; the source part runs only when forced or
    /// older than `sourceCheckTTL`. `force` also refreshes the marketplace
    /// catalogs server-side. Returns whether the Claude check answered, or nil
    /// when this refresh was superseded (a newer refresh, or a sign-out).
    @discardableResult
    func refresh(api: LlmIdeAPIClient, oneClick: Bool, force: Bool,
                 plugins: [PluginInfo]? = nil) async -> Bool? {
        if let plugins {
            knownPlugins = Dictionary(plugins.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        }
        // A forced check refreshes the marketplace catalogs (a second `claude
        // plugin` process); never alongside a running update. The UI disables
        // it too; this covers a check already queued when the update began.
        let force = force && !isUpdating
        lastOneClick = oneClick
        let vendorFresh = !force && lastCheck.map {
            $0.oneClick == oneClick && Date().timeIntervalSince($0.at) < Self.checkTTL
        } == true
        let tracked = PluginUpdateSources.tracked(knownPlugins)
        let sourcesDue = PluginUpdateSources.isDue(
            tracked: Set(tracked.map(\.name)), checked: sourceCheckedNames, lastCheck: lastSourceCheck,
            now: Date(), ttl: Self.sourceCheckTTL, force: force)
        let startSources = sourcesDue && (force || !sourceCheckRunning)
        if vendorFresh && !startSources {
            rebuildEntries()
            return true
        }
        let startedEpoch = epoch
        // Only a refresh that fetches the vendor part takes a generation: a
        // source-only refresh must not void a vendor answer still in flight.
        var generation: Int?
        if !vendorFresh {
            refreshGeneration += 1
            generation = refreshGeneration
            vendorChecking = true
        }
        defer { if let generation, generation == refreshGeneration { vendorChecking = false } }
        var sourceRun: Int?
        if startSources {
            sourceGeneration += 1
            sourceRun = sourceGeneration
            sourceCheckRunning = true
        }
        let checker = sourceChecker
        async let sourceAnswer: [String: SourceCheckResult]? = startSources ? checker.check(tracked) : nil
        let vendor: (found: [PluginUpdateEntry], claudeOK: Bool)? = vendorFresh ? nil
            : await fetchVendor(api: api, oneClick: oneClick, force: force)
        let answered = await sourceAnswer
        // resetForSignOut bumps both generations and the epoch, so no part of
        // a previous account's check is written.
        if let sourceRun, sourceRun == sourceGeneration {
            sourceCheckRunning = false
            if let answered { applySourceResults(answered, tracked: tracked, force: force) }
            rebuildEntries()
        }
        guard startedEpoch == epoch else { return nil }
        guard let generation, let vendor else { return true }
        guard generation == refreshGeneration else { return nil }
        vendorEntries = vendor.found
        lastCheck = (Date(), oneClick)
        rebuildEntries()
        return vendor.claudeOK
    }

    /// Ask both bridges. Best-effort per vendor; `claudeOK` is whether the
    /// Claude check answered.
    private func fetchVendor(api: LlmIdeAPIClient, oneClick: Bool,
                             force: Bool) async -> (found: [PluginUpdateEntry], claudeOK: Bool) {
        guard oneClick else {
            let legacy: [PluginUpdate] = ((try? await api.claudePluginUpdates()) ?? [])
                + ((try? await api.codexPluginUpdates()) ?? [])
            return (legacy.map(PluginUpdateEntry.init(legacy:)), true)
        }
        var found: [PluginUpdateEntry] = []
        var claudeOK = true
        do { found += try await api.claudePluginUpdates(force: force).updates } catch { claudeOK = false }
        found += (try? await api.codexPluginUpdateCheck())?.updates ?? []
        return (found, claudeOK)
    }

    /// The detail pane's "Check for updates": a forced check, with the
    /// outcome recorded for `name`. `info` is the pane's own copy of the
    /// plugin, so a check works before the Library has listed it.
    func check(name: String, info: PluginInfo?, api: LlmIdeAPIClient, oneClick: Bool) async {
        if let info { knownPlugins[name] = info }
        guard let ok = await refresh(api: api, oneClick: oneClick, force: true) else { return }
        let kind = knownPlugins[name]?.installSource?.kind
        if kind == "git" || kind == "marketplace" {
            // A failure was already written by the source check.
            if sourceFailures[name] != nil { return }
            results[name] = entry(for: name) == nil
                ? Result(message: "Checked — no update found.", failed: false) : nil
        } else if !ok {
            results[name] = Result(message: "Could not check for updates.", failed: true)
        } else if entry(for: name) == nil {
            results[name] = Result(message: "Checked — no update found.", failed: false)
        } else {
            results[name] = nil
        }
    }

    private func applySourceResults(_ answered: [String: SourceCheckResult],
                                    tracked: PluginUpdateSources.Tracked, force: Bool) {
        let (found, failures) = PluginUpdateSources.outcome(answered, tracked: tracked)
        // Clear only what an earlier source check wrote; an update's own
        // result stays until that plugin is updated or checked again.
        for (name, old) in sourceFailures where failures[name] == nil && results[name]?.message == old {
            results[name] = nil
        }
        for (name, message) in failures where force || results[name] == nil || sourceFailures[name] != nil {
            results[name] = Result(message: message, failed: true)
        }
        sourceFailures = failures
        sourceEntries = found
        sourceCheckedNames = Set(tracked.map(\.name))
        lastSourceCheck = Date()
    }

    private func rebuildEntries() {
        entries = PluginUpdateSources.merge(vendor: vendorEntries, source: sourceEntries,
                                            plugins: knownPlugins, oneClick: lastOneClick,
                                            expectSupported: supportsExpect)
    }

    // MARK: - Update (entry points)

    /// Update one plugin (Library header menu or detail pane). No-op while
    /// another update runs. The result goes to `results[name]`, and for the
    /// Library also to its alert.
    func startUpdate(name: String, api: LlmIdeAPIClient, oneClick: Bool, origin: Origin) {
        guard !isUpdating else { return }
        isRunning = true
        let started = epoch
        Task {
            let step = await run(name: name, api: api, oneClick: oneClick, acceptCommand: nil, origin: origin)
            guard started == epoch else { return }
            isRunning = false
            finish(step, name: name, origin: origin, prefix: nil)
        }
    }

    /// Replace a file-installed plugin with the zip the user picked. Same
    /// guards and result plumbing as `startUpdate`.
    func startReplaceFromFile(name: String, zipURL: URL, api: LlmIdeAPIClient, oneClick: Bool) {
        guard !isUpdating else { return }
        isRunning = true
        let started = epoch
        Task {
            let step = await run(name: name, api: api, oneClick: oneClick, acceptCommand: nil,
                                 origin: .detail, fileURL: zipURL)
            guard started == epoch else { return }
            isRunning = false
            finish(step, name: name, origin: .detail, prefix: nil)
        }
    }

    /// Sequential, one server-side update at a time. No-op while another
    /// update runs. Stops at the first plugin that needs a confirmation, or
    /// when the server is busy / already updating — the rest would only fail
    /// the same way.
    func startUpdateAll(api: LlmIdeAPIClient, oneClick: Bool) {
        guard !isUpdating else { return }
        isRunning = true
        let started = epoch
        Task {
            await runAll(api: api, oneClick: oneClick)
            if started == epoch { isRunning = false }
        }
    }

    /// The user accepted the command shown in the sheet. Takes the deferred
    /// "Update all" summary synchronously, before the sheet's dismissal could
    /// flush it.
    func accept(_ confirmation: PluginUpdateConfirmation, api: LlmIdeAPIClient, oneClick: Bool) {
        // Refused while something runs: the sheet stays up, nothing is lost.
        guard !isUpdating else { return }
        let origin = pendingOrigin
        let prefix = deferredSummary
        deferredSummary = nil
        pendingConfirmation = nil
        isRunning = true
        let started = epoch
        Task {
            let step = await run(name: confirmation.pluginName, api: api, oneClick: oneClick,
                                 acceptCommand: confirmation.sha256, origin: origin)
            guard started == epoch else { return }
            isRunning = false
            if case .confirm = step {
                // The command changed again: keep the summary for the next answer.
                deferredSummary = prefix
                return
            }
            finish(step, name: confirmation.pluginName, origin: origin, prefix: prefix)
        }
    }

    /// The sheet went away without Accept: show what an "Update all" did
    /// before it stopped, then forget it.
    func confirmationDismissed() {
        guard let deferredSummary else { return }
        self.deferredSummary = nil
        post(deferredSummary)
    }

    // MARK: - Update (internals)

    private func runAll(api: LlmIdeAPIClient, oneClick: Bool) async {
        let started = epoch
        let pending = entries
        var succeeded = 0
        var failures: [(name: String, message: String)] = []
        var trustResets: [String] = []
        var claudeUpdated = false
        var stoppedForConfirmation = false
        for update in pending {
            let step = await run(name: update.name, api: api, oneClick: oneClick, acceptCommand: nil, origin: .library)
            guard started == epoch else { return }
            switch step {
            case .discarded:
                return
            case .confirm:
                stoppedForConfirmation = true
            case let .done(message, ok, trustReset, _, movedClaude):
                results[update.name] = Result(message: message, failed: !ok)
                if ok { succeeded += 1 } else { failures.append((update.name, message)) }
                if trustReset { trustResets.append(update.name) }
                if movedClaude { claudeUpdated = true }
            }
            if stoppedForConfirmation || step.stopsBatch { break }
        }
        // No await from here on: each successful `run` already re-checked, and
        // `isRunning` must drop in the same turn a confirmation sheet opens, so
        // its Accept is never refused as "already updating".
        let summary = PluginUpdatePresentation.updateAllSummary(
            succeeded: succeeded, failures: failures, trustResets: trustResets,
            claudeUpdated: claudeUpdated)
        if stoppedForConfirmation {
            deferredSummary = succeeded + failures.count > 0 ? summary : nil
        } else {
            post(summary)
        }
    }

    private func finish(_ step: PluginUpdateStep, name: String, origin: Origin, prefix: String?) {
        guard case let .done(message, ok, _, _, _) = step else { return }
        results[name] = Result(message: message, failed: !ok)
        post(PluginUpdatePresentation.libraryMessage(prefix: prefix, message: origin == .library ? message : nil))
    }

    /// Set the Library alert, never to an empty string (an empty alert is the
    /// symptom of a dropped result reaching the UI).
    private func post(_ message: String?) {
        guard let message, !message.isEmpty else { return }
        libraryMessage = message
    }

    /// One plugin, routed by `PluginUpdatePresentation.action`: a git or
    /// marketplace install is fetched again from its recorded origin, a Claude
    /// import on a v60+ server goes through Claude Code's own update, other
    /// imports re-import from their vendor, and a file install is replaced
    /// only with the file the user picked (`fileURL`). A step that finishes
    /// after a sign-out comes back `.discarded` with nothing written.
    private func run(name: String, api: LlmIdeAPIClient, oneClick: Bool,
                     acceptCommand: String?, origin: Origin, fileURL: URL? = nil) async -> PluginUpdateStep {
        let started = epoch
        inFlight.insert(name)
        defer { if started == epoch { inFlight.remove(name) } }
        let info = knownPlugins[name]
        let action = fileURL == nil
            ? PluginUpdatePresentation.action(name: name, origin: info?.origin, installSource: info?.installSource,
                                              entry: entry(for: name), oneClick: oneClick,
                                              expectSupported: supportsExpect)
            : (supportsExpect ? .replaceFromFile : .none)
        let step: PluginUpdateStep
        switch action {
        case .claudeOneClick:
            step = await runOneClick(name: name, api: api, acceptCommand: acceptCommand)
        case .reimportClaude, .reimportCodex:
            step = await runReimport(name: name, api: api, codex: action == .reimportCodex)
        case .gitReinstall:
            step = await PluginSourceReinstaller.git(name: name, source: info?.installSource, api: api)
        case .marketplaceReinstall:
            step = await PluginSourceReinstaller.marketplace(name: name, source: info?.installSource, api: api)
        case .replaceFromFile:
            if let fileURL {
                step = await PluginSourceReinstaller.replaceFromFile(name: name, zipURL: fileURL, api: api)
            } else {
                step = .done(message: "\(name) was installed from a file — use Replace from file… in its detail pane.",
                             succeeded: false, trustReset: false, stopsBatch: false)
            }
        case .none:
            step = .done(message: "\(name) has no recorded source to update from.",
                         succeeded: false, trustReset: false, stopsBatch: false)
        }
        guard started == epoch else { return .discarded }
        switch step {
        case let .confirm(command, sha256):
            // Only now, after the epoch check: a confirmation for the previous
            // account must never open (Accept would run it under the new one).
            pendingOrigin = origin
            pendingConfirmation = PluginUpdateConfirmation(pluginName: name, command: command, sha256: sha256)
        case let .done(_, ok, _, _, _):
            if ok {
                // The content now matches the source: its old "newer version"
                // row must not survive until the next 30-minute source check.
                sourceEntries.removeAll { $0.name == name }
                sourceFailures[name] = nil
                // The reinstall recorded a NEW commit/tree for this plugin.
                // `afterChange` re-checks sources against `knownPlugins`, so
                // reload it first: otherwise the check compares the remote
                // against the PRE-update commit, finds a "newer" one, and the
                // Update badge comes straight back for another 30 minutes.
                if let fresh = try? await api.listPlugins().plugins, started == epoch {
                    knownPlugins = Dictionary(fresh.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
                }
                await afterChange(api: api, oneClick: oneClick)
            }
            guard started == epoch else { return .discarded }
        case .discarded:
            break
        }
        return step
    }

    private func runOneClick(name: String, api: LlmIdeAPIClient, acceptCommand: String?) async -> PluginUpdateStep {
        do {
            let outcome = try await api.updateClaudePlugin(name: name, acceptCommand: acceptCommand)
            return PluginUpdateStep(name: name, outcome: outcome)
        } catch {
            return .done(message: "Could not update \(name): \(error.localizedDescription)",
                         succeeded: false, trustReset: false, stopsBatch: false)
        }
    }

    private func runReimport(name: String, api: LlmIdeAPIClient, codex: Bool) async -> PluginUpdateStep {
        let entry = entry(for: name)
        let sourceName = entry?.sourcePluginName ?? name
        let source = entry?.source ?? "installed"
        do {
            if codex {
                _ = try await api.importCodexPlugin(name: sourceName, source: source)
            } else {
                _ = try await api.importClaudePlugin(name: sourceName, source: source)
            }
            let target: String = entry?.targetVersion.map { " to v\($0)" } ?? ""
            return .done(message: "Updated \(name)\(target).", succeeded: true, trustReset: false, stopsBatch: false)
        } catch {
            return .done(message: "Could not update \(name): \(error.localizedDescription)",
                         succeeded: false, trustReset: false, stopsBatch: false)
        }
    }

    /// Something changed: re-check (bypassing the TTL) and tell the Library.
    private func afterChange(api: LlmIdeAPIClient, oneClick: Bool) async {
        lastCheck = nil
        changeToken += 1
        await refresh(api: api, oneClick: oneClick, force: false)
    }
}
