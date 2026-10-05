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
    /// Settable so a sheet can bind to it; set to nil to dismiss.
    var pendingConfirmation: PluginUpdateConfirmation?
    private(set) var pendingOrigin: Origin = .library
    private(set) var results: [String: Result] = [:]
    /// What an "Update all" did before stopping for a confirmation.
    private(set) var deferredSummary: String?
    /// A message for the Library's alert; the Library consumes it (also on
    /// re-appear, so a result that landed while it was gone is still shown).
    var libraryMessage: String?
    /// Bumped after any update that changed something, so the Library reloads
    /// its plugin list even when the surface that started it is gone.
    private(set) var changeToken = 0

    /// Non-forced checks within this window reuse the last answer.
    static let checkTTL: TimeInterval = 60
    private var lastCheck: (at: Date, oneClick: Bool)?
    /// Bumped on sign-out; work started under an older epoch reports nothing.
    private var epoch = 0

    private init() {
        // Library may name Core; Core never names Library, so enroll here.
        SessionScopedRegistry.shared.register(self)
    }

    var isUpdating: Bool { !inFlight.isEmpty }

    func entry(for name: String) -> PluginUpdateEntry? {
        entries.first { $0.name == name }
    }

    func resetForSignOut() {
        epoch += 1
        entries = []
        checking = false
        inFlight = []
        pendingConfirmation = nil
        results = [:]
        deferredSummary = nil
        libraryMessage = nil
        lastCheck = nil
    }

    // MARK: - Check

    /// Ask both bridges what the vendor sources offer. Best-effort per vendor:
    /// a machine without Claude Code or Codex simply has no updates.
    ///
    /// Pre: `oneClick` is the v60 gate for the current server.
    /// Post: `entries` is fresh unless a non-forced check ran under `checkTTL`
    /// ago against the same server generation. `force` also refreshes the
    /// marketplace catalogs server-side. Returns false when the Claude check
    /// itself failed (only reported for a v60+ check).
    @discardableResult
    func refresh(api: LlmIdeAPIClient, oneClick: Bool, force: Bool) async -> Bool {
        if !force, let lastCheck, lastCheck.oneClick == oneClick,
           Date().timeIntervalSince(lastCheck.at) < Self.checkTTL {
            return true
        }
        let started = epoch
        checking = true
        defer { if started == epoch { checking = false } }
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
        guard started == epoch else { return claudeOK }
        entries = found
        lastCheck = (Date(), oneClick)
        return claudeOK
    }

    /// The detail pane's "Check for updates": a forced check, with the
    /// outcome recorded for `name`.
    func check(name: String, api: LlmIdeAPIClient, oneClick: Bool) async {
        let started = epoch
        let ok = await refresh(api: api, oneClick: oneClick, force: true)
        guard started == epoch else { return }
        if !ok {
            results[name] = Result(message: "Could not check for updates.", failed: true)
        } else if entry(for: name) == nil {
            results[name] = Result(message: "Checked — no update found.", failed: false)
        } else {
            results[name] = nil
        }
    }

    // MARK: - Update

    /// How one update ended.
    enum Step {
        /// Stopped: the confirmation sheet is now pending.
        case confirm
        case done(message: String, succeeded: Bool, trustReset: Bool, stopsBatch: Bool)
    }

    /// Update one plugin from the Library header menu or the detail pane. The
    /// result goes to `results[name]`, and for the Library also its alert.
    func update(name: String, api: LlmIdeAPIClient, oneClick: Bool, origin: Origin) async {
        let step = await run(name: name, api: api, oneClick: oneClick, acceptCommand: nil, origin: origin)
        finish(step, name: name, origin: origin, prefix: nil)
    }

    /// Sequential, one server-side update at a time. Stops at the first plugin
    /// that needs a confirmation, or when the server is busy / already
    /// updating — the rest would only fail the same way.
    func updateAll(api: LlmIdeAPIClient, oneClick: Bool) async {
        let started = epoch
        let pending = entries
        var succeeded = 0
        var failures: [(name: String, message: String)] = []
        var trustResets: [String] = []
        var stoppedForConfirmation = false
        for update in pending {
            let step = await run(name: update.name, api: api, oneClick: oneClick, acceptCommand: nil, origin: .library)
            guard started == epoch else { return }
            guard case let .done(message, ok, trustReset, stopsBatch) = step else {
                stoppedForConfirmation = true
                break
            }
            results[update.name] = Result(message: message, failed: !ok)
            if ok { succeeded += 1 } else { failures.append((update.name, message)) }
            if trustReset { trustResets.append(update.name) }
            if stopsBatch { break }
        }
        let summary = PluginUpdatePresentation.updateAllSummary(
            succeeded: succeeded, failures: failures, trustResets: trustResets,
            claudeUpdated: oneClick && succeeded > 0 && pending.contains { $0.name.hasPrefix("claude-") })
        await afterChange(api: api, oneClick: oneClick)
        if stoppedForConfirmation {
            deferredSummary = succeeded + failures.count > 0 ? summary : nil
        } else {
            libraryMessage = summary
        }
    }

    /// The user accepted the command shown in the sheet. Takes the deferred
    /// "Update all" summary synchronously, before the sheet's dismissal could
    /// flush it.
    func accept(_ confirmation: PluginUpdateConfirmation, api: LlmIdeAPIClient, oneClick: Bool) async {
        let origin = pendingOrigin
        let prefix = deferredSummary
        deferredSummary = nil
        pendingConfirmation = nil
        let step = await run(name: confirmation.pluginName, api: api, oneClick: oneClick,
                             acceptCommand: confirmation.sha256, origin: origin)
        if case .confirm = step {
            // The command changed again: keep the summary for the next answer.
            deferredSummary = prefix
            return
        }
        finish(step, name: confirmation.pluginName, origin: origin, prefix: prefix)
    }

    /// The sheet went away without Accept: show what an "Update all" did
    /// before it stopped, then forget it.
    func confirmationDismissed() {
        guard let deferredSummary else { return }
        self.deferredSummary = nil
        libraryMessage = deferredSummary
    }

    private func finish(_ step: Step, name: String, origin: Origin, prefix: String?) {
        guard case let .done(message, ok, _, _) = step else { return }
        results[name] = Result(message: message, failed: !ok)
        if origin == .library {
            libraryMessage = [prefix, message].compactMap { $0 }.joined(separator: "\n\n")
        } else if let prefix {
            libraryMessage = prefix
        }
    }

    /// One plugin. A Claude import on a v60+ server goes through Claude Code's
    /// own update (then a re-import); everything else re-imports at the version
    /// its source offers — the same call the import sheets make.
    private func run(name: String, api: LlmIdeAPIClient, oneClick: Bool,
                     acceptCommand: String?, origin: Origin) async -> Step {
        let started = epoch
        inFlight.insert(name)
        defer { if started == epoch { inFlight.remove(name) } }
        let step: Step
        if oneClick && name.hasPrefix("claude-") {
            step = await runOneClick(name: name, api: api, acceptCommand: acceptCommand)
        } else {
            step = await runReimport(name: name, api: api)
        }
        guard started == epoch else { return .done(message: "", succeeded: false, trustReset: false, stopsBatch: true) }
        switch step {
        case .confirm:
            pendingOrigin = origin
        case let .done(_, ok, _, _):
            if ok { await afterChange(api: api, oneClick: oneClick) }
        }
        return step
    }

    private func runOneClick(name: String, api: LlmIdeAPIClient, acceptCommand: String?) async -> Step {
        do {
            let outcome = try await api.updateClaudePlugin(name: name, acceptCommand: acceptCommand)
            let message = PluginUpdatePresentation.message(name: name, outcome: outcome) ?? ""
            switch outcome {
            case let .needsConfirmation(command, sha256):
                pendingConfirmation = PluginUpdateConfirmation(pluginName: name, command: command, sha256: sha256)
                return .confirm
            case let .updated(_, _, trustReset):
                return .done(message: message, succeeded: true, trustReset: trustReset, stopsBatch: false)
            case .busy, .inProgress:
                return .done(message: message, succeeded: false, trustReset: false, stopsBatch: true)
            case .cliFailed, .reimportFailed, .notFound:
                return .done(message: message, succeeded: false, trustReset: false, stopsBatch: false)
            }
        } catch {
            return .done(message: "Could not update \(name): \(error.localizedDescription)",
                         succeeded: false, trustReset: false, stopsBatch: false)
        }
    }

    private func runReimport(name: String, api: LlmIdeAPIClient) async -> Step {
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
