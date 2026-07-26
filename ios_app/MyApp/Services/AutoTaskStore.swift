import Foundation
import SharedProtocol

/// State + send/handle logic for the Auto Tasks surface (the "Auto" sheet):
/// the Mac-side auto-task state, recent run history, and the transient toast
/// for one-shot action acks. No chat/streaming. Holds a weak reference to the
/// `ConnectionService` to send outbound frames.
///
/// The Mac is the sole executor — every run/toggle/stop is proxied over the
/// WebSocket and the phone mirrors live `AutoTaskState` snapshots.
@MainActor
final class AutoTaskStore: ObservableObject {
    /// Auto-task status (Mac-side). Refreshed after list/run/stop/toggle and
    /// while a run is in progress (polling).
    @Published var autoTaskState: AutoTaskState?
    /// Recent run history. Arrives only in response to `autoTaskHistory()`.
    @Published var autoTaskHistoryEntries: [AutoTaskHistoryEntry] = []
    /// Transient confirmation of one-shot actions (auto-task acks); auto-clears.
    /// Read by the shell (`MobileHomeView`) for the action toast.
    @Published var actionStatus: String?
    /// Last auto-task wire error (e.g. Mac not configured).
    @Published var lastError: String?

    private var actionStatusTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.autoTaskStore = self
    }

    // MARK: — Senders

    /// Ask the Mac for the current auto-task state. The Mac replies with
    /// `auto_task_state`, which lands in `autoTaskState`.
    func autoTaskList() {
        connection?.sendEncodable(AutoTaskList())
    }

    /// Start the auto-task loop on the Mac. Pass a `task` id to scope it to
    /// one task, or nil to run all enabled tasks.
    func autoTaskRun(_ task: String? = nil) {
        lastError = nil
        connection?.sendEncodable(AutoTaskRun(task: task))
        autoTaskList()
    }

    /// Stop the auto-task loop on the Mac.
    func autoTaskStop() {
        lastError = nil
        connection?.sendEncodable(AutoTaskStop())
        autoTaskList()
    }

    /// Toggle a single task's enabled flag, or the master switch when `task`
    /// is nil. The Mac replies with a fresh `auto_task_state`.
    func autoTaskToggle(task: String?, enabled: Bool) {
        lastError = nil
        connection?.sendEncodable(AutoTaskToggle(task: task, enabled: enabled))
        autoTaskList()
    }

    /// Ask the Mac for recent auto-task run history. The Mac replies with
    /// `auto_task_history_reply`, which lands in `autoTaskHistoryEntries`.
    func autoTaskHistory() {
        connection?.sendEncodable(AutoTaskHistoryList())
    }

    /// Refresh list + history (e.g. on connect or pull-to-refresh).
    func refreshAll() {
        autoTaskList()
        autoTaskHistory()
    }

    // MARK: — Inbound (called by ConnectionService.receiveMessage dispatch)

    func handleInbound(type: String, data: Data) {
        switch type {
        case "auto_task_state":
            if let state = try? JSONDecoder().decode(AutoTaskState.self, from: data) {
                applyState(state)
            }
        case "auto_task_history_reply":
            if let reply = try? JSONDecoder().decode(AutoTaskHistoryReply.self, from: data) {
                autoTaskHistoryEntries = reply.entries
            }
        case "auto_task_ack":
            if let ack = try? JSONDecoder().decode(AutoTaskAck.self, from: data) {
                if ack.ok {
                    autoTaskList()
                    autoTaskHistory()
                } else if let msg = ack.message {
                    lastError = msg
                    setActionStatus(msg)
                }
            }
        default:
            break
        }
    }

    /// Surface `CommandError` frames whose commandId is auto-task scoped.
    func handleCommandError(_ message: String, commandId: String?) {
        guard let commandId, commandId.hasPrefix("auto_task") else { return }
        lastError = message
        setActionStatus(message)
    }

    func clearError() { lastError = nil }

    // MARK: — Private

    private func applyState(_ state: AutoTaskState) {
        autoTaskState = state
        if state.isRunning {
            startPollingIfNeeded()
        } else {
            stopPolling()
            autoTaskHistory()
        }
    }

    /// While the Mac reports `isRunning`, poll every 2s so `currentStep` and
    /// counts stay in sync without manual refresh.
    private func startPollingIfNeeded() {
        guard pollTask == nil else { return }
        pollTask = Task { @MainActor [weak self] in
            defer { self?.stopPolling() }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled else { return }
                guard let self, self.autoTaskState?.isRunning == true else { return }
                self.autoTaskList()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func setActionStatus(_ message: String) {
        actionStatus = message
        actionStatusTask?.cancel()
        actionStatusTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            self?.actionStatus = nil
        }
    }
}
