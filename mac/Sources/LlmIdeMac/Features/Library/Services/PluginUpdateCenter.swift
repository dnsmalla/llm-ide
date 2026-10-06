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
    private(set) var checking = false
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
    private var lastCheck: (at: Date, oneClick: Bool)?
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
        checking = false
        inFlight = []
        isRunning = false
        pendingConfirmation = nil
        results = [:]
        deferredSummary = nil
        libraryMessage = nil
        lastCheck = nil
    }

    /// Forget the last check, so the next non-forced refresh fetches. Called
    /// when the plugin set changed outside the center (import, remove, reload).
    func invalidateCheck() {
        lastCheck = nil
    }

    // MARK: - Check

    /// Ask both bridges what the vendor sources offer. Best-effort per vendor:
    /// a machine without Claude Code or Codex simply has no updates.
    ///
    /// Pre: `oneClick` is the v60 gate for the current server.
    /// Post: `entries` is fresh unless a non-forced check ran under `checkTTL`
    /// ago against the same gate. `force` also refreshes the marketplace
    /// catalogs server-side. Returns whether the Claude check answered, or nil
    /// when this refresh was superseded (a newer refresh, or a sign-out).
    @discardableResult
    func refresh(api: LlmIdeAPIClient, oneClick: Bool, force: Bool) async -> Bool? {
        if !force, let lastCheck, lastCheck.oneClick == oneClick,
           Date().timeIntervalSince(lastCheck.at) < Self.checkTTL {
            return true
        }
        refreshGeneration += 1
        let generation = refreshGeneration
        checking = true
        defer { if generation == refreshGeneration { checking = false } }
        var found: [PluginUpdateEntry] = []
        var claudeOK = true
        if oneClick {
            do { found += try await api.claudePluginUpdates(force: force).updates } catch { claudeOK = false }
            found += (try? await api.codexPluginUpdateCheck())?.updates ?? []
        } else {
            let legacy: [PluginUpdate] = ((try? await api.claudePluginUpdates()) ?? [])
                + ((try? await api.codexPluginUpdates()) ?? [])
            found = legacy.map(PluginUpdateEntry.init(legacy:))
        }
        // resetForSignOut bumps the generation too, so this also drops a
        // result that belongs to the previous account.
        guard generation == refreshGeneration else { return nil }
        entries = found
        lastCheck = (Date(), oneClick)
        return claudeOK
    }

    /// The detail pane's "Check for updates": a forced check, with the
    /// outcome recorded for `name`.
    func check(name: String, api: LlmIdeAPIClient, oneClick: Bool) async {
        guard let ok = await refresh(api: api, oneClick: oneClick, force: true) else { return }
        if !ok {
            results[name] = Result(message: "Could not check for updates.", failed: true)
        } else if entry(for: name) == nil {
            results[name] = Result(message: "Checked — no update found.", failed: false)
        } else {
            results[name] = nil
        }
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
        var stoppedForConfirmation = false
        for update in pending {
            let step = await run(name: update.name, api: api, oneClick: oneClick, acceptCommand: nil, origin: .library)
            guard started == epoch else { return }
            switch step {
            case .discarded:
                return
            case .confirm:
                stoppedForConfirmation = true
            case let .done(message, ok, trustReset, _):
                results[update.name] = Result(message: message, failed: !ok)
                if ok { succeeded += 1 } else { failures.append((update.name, message)) }
                if trustReset { trustResets.append(update.name) }
            }
            if stoppedForConfirmation || step.stopsBatch { break }
        }
        // No await from here on: each successful `run` already re-checked, and
        // `isRunning` must drop in the same turn a confirmation sheet opens, so
        // its Accept is never refused as "already updating".
        let summary = PluginUpdatePresentation.updateAllSummary(
            succeeded: succeeded, failures: failures, trustResets: trustResets,
            claudeUpdated: oneClick && succeeded > 0 && pending.contains { $0.name.hasPrefix("claude-") })
        if stoppedForConfirmation {
            deferredSummary = succeeded + failures.count > 0 ? summary : nil
        } else {
            post(summary)
        }
    }

    private func finish(_ step: PluginUpdateStep, name: String, origin: Origin, prefix: String?) {
        guard case let .done(message, ok, _, _) = step else { return }
        results[name] = Result(message: message, failed: !ok)
        post(PluginUpdatePresentation.libraryMessage(prefix: prefix, message: origin == .library ? message : nil))
    }

    /// Set the Library alert, never to an empty string (an empty alert is the
    /// symptom of a dropped result reaching the UI).
    private func post(_ message: String?) {
        guard let message, !message.isEmpty else { return }
        libraryMessage = message
    }

    /// One plugin. A Claude import on a v60+ server goes through Claude Code's
    /// own update (then a re-import); everything else re-imports at the version
    /// its source offers — the same call the import sheets make. A step that
    /// finishes after a sign-out comes back `.discarded` with nothing written.
    private func run(name: String, api: LlmIdeAPIClient, oneClick: Bool,
                     acceptCommand: String?, origin: Origin) async -> PluginUpdateStep {
        let started = epoch
        inFlight.insert(name)
        defer { if started == epoch { inFlight.remove(name) } }
        let step: PluginUpdateStep
        if oneClick && name.hasPrefix("claude-") {
            step = await runOneClick(name: name, api: api, acceptCommand: acceptCommand)
        } else {
            step = await runReimport(name: name, api: api)
        }
        guard started == epoch else { return .discarded }
        switch step {
        case let .confirm(command, sha256):
            // Only now, after the epoch check: a confirmation for the previous
            // account must never open (Accept would run it under the new one).
            pendingOrigin = origin
            pendingConfirmation = PluginUpdateConfirmation(pluginName: name, command: command, sha256: sha256)
        case let .done(_, ok, _, _):
            if ok { await afterChange(api: api, oneClick: oneClick) }
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

    private func runReimport(name: String, api: LlmIdeAPIClient) async -> PluginUpdateStep {
        let entry = entry(for: name)
        let sourceName = entry?.sourcePluginName ?? name
        let source = entry?.source ?? "installed"
        do {
            if name.hasPrefix("codex-") {
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
