import Foundation
import SharedProtocol

/// State + send/handle logic for the Loop surface.
///
/// The phone is a remote control: it asks the Mac for a snapshot, asks it to
/// start or stop, and renders what comes back. Nothing about how a loop runs
/// lives here — no stage logic, no config editing, no repair decisions. Those
/// stay in the Mac app, which is also where the wizard and the stage editors
/// are. Mirrors `AutoTaskStore`'s shape so the two surfaces behave alike.
@MainActor
final class LoopStore: ObservableObject {
    /// Latest Mac snapshot. nil until the first `loop_state` arrives.
    @Published var state: LoopState?
    /// Finished runs, from the Mac's journal. Arrives only on request.
    @Published var history: [LoopRunSummary] = []
    /// Transient confirmation of start/stop, auto-clears.
    @Published var actionStatus: String?
    /// Last wire error (e.g. the Mac has no loop configured).
    @Published var lastError: String?

    private var actionStatusTask: Task<Void, Never>?
    private var firstReplyWatchdog: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    /// Generation stamp so a cancelled poll loop can never clear the handle of
    /// the loop that replaced it — the duplicate-timer bug AutoTaskStore hit.
    private var pollGeneration = 0

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.loopStore = self
    }

    // MARK: — Senders

    /// Ask for the current snapshot. The Mac replies `loop_state`.
    func refresh() {
        connection?.sendEncodable(LoopStatusList())
        armFirstReplyWatchdog()
    }

    /// A Mac that does not understand `loop_status_list` logs "unhandled
    /// inbound type" and sends NOTHING back, so the page would sit on
    /// "Loading loop status…" forever with no clue why. That is exactly what a
    /// Mac app older than this feature does, which is the most likely reason
    /// this page ever looks empty — so say so instead of spinning.
    private func armFirstReplyWatchdog() {
        guard state == nil else { return }        // only the very first answer
        firstReplyWatchdog?.cancel()
        firstReplyWatchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard let self, !Task.isCancelled, self.state == nil else { return }
            self.lastError = "Your Mac didn't answer. Update and relaunch the Mac app — this page needs a build that supports Loop."
        }
    }

    func loadHistory(limit: Int = 15) {
        connection?.sendEncodable(LoopHistoryRequest(limit: limit))
    }

    func refreshAll() {
        refresh()
        loadHistory()
    }

    /// Start the active project's loop on the Mac. The Mac may decline — a run
    /// already in flight is the common case — which arrives as a `LoopAck`
    /// with `accepted: false` and is shown as a status, not an error.
    func start() {
        lastError = nil
        connection?.sendEncodable(LoopStart())
    }

    func stop() {
        lastError = nil
        connection?.sendEncodable(LoopStop())
    }

    // MARK: — Polling

    /// Poll while a run is in flight so the log tail and status advance without
    /// the user pulling to refresh. Stops as soon as the Mac reports idle, so
    /// an idle phone left on this screen is not talking to the Mac every 2s.
    func startPollingIfRunning() {
        guard state?.running == true else { return }
        pollGeneration += 1
        let generation = pollGeneration
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self, !Task.isCancelled, generation == self.pollGeneration else { return }
                guard self.state?.running == true else {
                    // One last refresh so the terminal status and the finished
                    // run land before polling stops.
                    self.refreshAll()
                    return
                }
                self.refresh()
            }
        }
    }

    func stopPolling() {
        pollGeneration += 1
        pollTask?.cancel()
        pollTask = nil
    }

    /// Clear everything when the phone pairs with a different Mac — otherwise
    /// the previous Mac's run history would read as this one's.
    func resetForNewDevice() {
        state = nil
        history = []
        actionStatus = nil
        lastError = nil
        stopPolling()
        firstReplyWatchdog?.cancel()
        firstReplyWatchdog = nil
    }

    // MARK: — Inbound

    func handleInbound(type: String, data: Data) {
        // Any reply at all proves the Mac understands this channel.
        firstReplyWatchdog?.cancel()
        firstReplyWatchdog = nil
        switch type {
        case MobileProtocol.Tag.loopState:
            guard let s = try? JSONDecoder().decode(LoopState.self, from: data) else { return }
            let wasRunning = state?.running ?? false
            state = s
            // A run that just started needs the poller armed; one that just
            // finished needs history refreshed so it appears in the list.
            if s.running && !wasRunning { startPollingIfRunning() }
            if !s.running && wasRunning { loadHistory() }

        case MobileProtocol.Tag.loopAck:
            guard let ack = try? JSONDecoder().decode(LoopAck.self, from: data) else { return }
            showActionStatus(ack.message)
            // Re-read rather than assuming: a declined start leaves the Mac's
            // state exactly as it was, and an accepted one changes it.
            refresh()

        case MobileProtocol.Tag.loopHistoryReply:
            guard let reply = try? JSONDecoder().decode(LoopHistoryReply.self, from: data) else { return }
            history = reply.runs

        default:
            break
        }
    }

    func handleCommandError(_ message: String) {
        lastError = message
    }

    private func showActionStatus(_ text: String) {
        actionStatus = text
        actionStatusTask?.cancel()
        actionStatusTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.actionStatus = nil
        }
    }
}
