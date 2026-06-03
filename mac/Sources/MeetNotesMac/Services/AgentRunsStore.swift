import Foundation
import SwiftUI
import os.log

/// Polls `/kb/agent/runs` so the global agent badge in the status
/// bar and the Cmd-Shift-A sheet share one source of truth.
/// Refresh happens on demand (popover open, sheet open) plus a slow
/// background tick so the badge stays roughly current without
/// hammering the API. Polling is the right shape here — the runs
/// list is small and the server doesn't push state.
@MainActor
final class AgentRunsStore: ObservableObject {
    @Published private(set) var runs: [MeetNotesAPIClient.AgentRun] = []
    @Published private(set) var lastError: String?
    @Published private(set) var refreshing: Bool = false

    private weak var api: MeetNotesAPIClient?
    private var tickTask: Task<Void, Never>?
    private let log = Logger(subsystem: "com.meetnotes.macapp", category: "AgentRunsStore")

    /// Background poll interval.  20 s keeps the badge accurate without
    /// hammering the server.  The old 45 s interval meant that after a
    /// dispatch the badge could show "0 active" for almost a minute.
    /// Call sites that trigger a dispatch or stop call `refresh()` immediately
    /// so the badge flips within one round-trip rather than waiting for the
    /// next poll.
    private let pollInterval: Duration = .seconds(20)

    init(api: MeetNotesAPIClient? = nil) {
        self.api = api
        if api != nil { startTicking() }
    }

    func attach(api: MeetNotesAPIClient) {
        self.api = api
        startTicking()
    }

    /// `running` is loosely defined: a run with no `lastTickAt` or
    /// a recent tick (<3min). The server may keep stopped runs in
    /// the list briefly — we tolerate that by ignoring stale ticks.
    var runningCount: Int {
        let now = Date().timeIntervalSince1970
        return runs.filter { ($0.lastTickAt ?? $0.startedAt) > now - 180 }.count
    }

    var hasRunning: Bool { runningCount > 0 }

    func refresh() async {
        guard let api else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            self.runs = try await api.listAgentRuns()
            self.lastError = nil
        } catch {
            self.lastError = error.localizedDescription
            log.error("agent runs refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Internals

    private func startTicking() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: self?.pollInterval ?? .seconds(45))
            }
        }
    }

    deinit { tickTask?.cancel() }
}
