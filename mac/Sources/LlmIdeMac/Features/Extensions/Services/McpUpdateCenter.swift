import Foundation
import Observation

/// App-lifetime owner of MCP server update state: the last registry check, the
/// updates / re-syncs in flight and each server's last result.
///
/// Not view state on purpose (same reason as `PluginUpdateCenter`): the Shell's
/// section switch destroys a view's `@State`, so a multi-second registry call
/// started from the detail pane would lose its result. Sign-out bumps `epoch`;
/// work started under an older epoch writes nothing.
@MainActor
@Observable
final class McpUpdateCenter: SessionScoped {
    static let shared = McpUpdateCenter()

    struct Result: Equatable {
        let message: String
        let failed: Bool
    }

    private(set) var updates: [String: LlmIdeAPIClient.McpServerUpdate] = [:]
    private(set) var checking = false
    private(set) var inFlight: Set<String> = []
    private(set) var results: [String: Result] = [:]
    /// Fields that differ from the Claude Code / Codex source, per server id;
    /// absent when in sync or not asked.
    private(set) var drift: [String: [String]] = [:]
    private var epoch = 0
    private var checkGeneration = 0
    private var listCheckTask: Task<Void, Never>?

    private init() {
        SessionScopedRegistry.shared.register(self)
    }

    func resetForSignOut() {
        epoch += 1
        checkGeneration += 1
        listCheckTask?.cancel()
        listCheckTask = nil
        updates = [:]
        checking = false
        inFlight = []
        results = [:]
        drift = [:]
    }

    func update(for id: String) -> LlmIdeAPIClient.McpServerUpdate? { updates[id] }

    /// Start the list-load check without making the caller wait. The registry
    /// lookup can take seconds when npm/PyPI are slow, and the list's own
    /// loads (connectors, plugins) must not queue behind it. Owned here, not
    /// by the view, so leaving the section does not orphan it; the epoch and
    /// generation guards in `check` still drop a stale answer.
    func startListCheck(api: LlmIdeAPIClient) {
        guard !checking else { return }
        listCheckTask = Task { [weak self] in
            await self?.check(api: api, force: false)
        }
    }

    /// Ask the server which managed servers have a newer release. A failure
    /// keeps the previous answer; `id` (the open pane) gets the message.
    func check(api: LlmIdeAPIClient, force: Bool, reportTo id: String? = nil) async {
        let started = epoch
        checkGeneration += 1
        let generation = checkGeneration
        checking = true
        do {
            let answer = try await api.mcpUpdates(force: force)
            guard started == epoch, generation == checkGeneration else { return }
            updates = Dictionary(answer.servers.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            if let id, results[id]?.failed == true { results[id] = nil }
            if let id, force, updates[id]?.status == "up-to-date" {
                // The server may serve a forced check from its cache; state its
                // own timestamp rather than implying a fresh lookup.
                results[id] = Result(
                    message: McpUpdatePresentation.checkedText(checkedAt: answer.checkedAt, upToDate: true),
                    failed: false)
            }
        } catch {
            guard started == epoch, generation == checkGeneration else { return }
            if let id { results[id] = Result(message: "Could not check for updates: \(error.localizedDescription)", failed: true) }
        }
        checking = false
    }

    /// Re-pin `id` to the registry's latest (`latest` is what the user saw).
    /// Returns true when the server changed, so the caller can reload.
    func update(id: String, to latest: String?, expectArgs: [String], api: LlmIdeAPIClient) async -> Bool {
        guard !inFlight.contains(id) else { return false }
        let started = epoch
        inFlight.insert(id)
        defer { if started == epoch { inFlight.remove(id) } }
        do {
            let ack = try await api.updateMcpPlugin(id: id, to: latest, expectArgs: expectArgs)
            guard started == epoch else { return false }
            let target = ack.to.map { " to v\($0)" } ?? ""
            results[id] = Result(message: "Updated\(target). \(McpUpdatePresentation.afterChangeMessage)", failed: false)
            updates[id] = nil
            return true
        } catch {
            guard started == epoch else { return false }
            results[id] = Result(message: "Could not update: \(error.localizedDescription)", failed: true)
            return false
        }
    }

    /// Ask whether an imported server drifted from its source config.
    func loadDrift(id: String, api: LlmIdeAPIClient) async {
        let started = epoch
        let status = try? await api.mcpResyncStatus(id: id)
        guard started == epoch else { return }
        drift[id] = (status?.drift == true) ? status?.changes : nil
    }

    func resync(id: String, api: LlmIdeAPIClient) async -> Bool {
        guard !inFlight.contains(id) else { return false }
        let started = epoch
        inFlight.insert(id)
        defer { if started == epoch { inFlight.remove(id) } }
        do {
            _ = try await api.resyncMcpPlugin(id: id)
            guard started == epoch else { return false }
            drift[id] = nil
            results[id] = Result(message: "Re-synced. \(McpUpdatePresentation.afterChangeMessage)", failed: false)
            return true
        } catch {
            guard started == epoch else { return false }
            results[id] = Result(message: "Could not re-sync: \(error.localizedDescription)", failed: true)
            return false
        }
    }
}
