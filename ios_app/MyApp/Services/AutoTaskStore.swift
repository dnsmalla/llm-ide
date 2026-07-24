import Foundation
import SharedProtocol

/// State + send/handle logic for the Auto Tasks surface (the "Auto" sheet):
/// the Mac-side auto-task state, recent run history, and the transient toast
/// for one-shot action acks. No chat/streaming. Holds a weak reference to the
/// `ConnectionService` to send outbound frames.
@MainActor
final class AutoTaskStore: ObservableObject {
    /// Auto-task status (Mac-side). `autoTaskState` is refreshed by the Mac
    /// after every list/run/stop/toggle.
    @Published var autoTaskState: AutoTaskState?
    /// Recent run history. Arrives only in response to `autoTaskHistory()`.
    @Published var autoTaskHistoryEntries: [AutoTaskHistoryEntry] = []
    /// Transient confirmation of one-shot actions (auto-task acks); auto-clears.
    /// Read by the shell (`MobileHomeView`) for the action toast.
    @Published var actionStatus: String?

    private var actionStatusTask: Task<Void, Never>?

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        // Register so the receive loop can route `auto_task_*` frames here.
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
        connection?.sendEncodable(AutoTaskRun(task: task))
    }

    /// Stop the auto-task loop on the Mac.
    func autoTaskStop() {
        connection?.sendEncodable(AutoTaskStop())
    }

    /// Toggle a single task's enabled flag, or the master switch when `task`
    /// is nil. The Mac replies with a fresh `auto_task_state`.
    func autoTaskToggle(task: String?, enabled: Bool) {
        connection?.sendEncodable(AutoTaskToggle(task: task, enabled: enabled))
    }

    /// Ask the Mac for recent auto-task run history. The Mac replies with
    /// `auto_task_history_reply`, which lands in `autoTaskHistoryEntries`.
    func autoTaskHistory() {
        connection?.sendEncodable(AutoTaskHistoryList())
    }

    // MARK: — Inbound (called by ConnectionService.receiveMessage dispatch)

    /// Handle `auto_task_*` frames that refresh state / history / surface acks.
    func handleInbound(type: String, data: Data) {
        switch type {
        case "auto_task_state":
            if let state = try? JSONDecoder().decode(AutoTaskState.self, from: data) {
                autoTaskState = state
            }
        case "auto_task_history_reply":
            if let reply = try? JSONDecoder().decode(AutoTaskHistoryReply.self, from: data) {
                autoTaskHistoryEntries = reply.entries
            }
        case "auto_task_ack":
            // Minimal: surface a human message if the Mac sent one; ignore
            // quiet `ok` acks.
            if let ack = try? JSONDecoder().decode(AutoTaskAck.self, from: data),
               let msg = ack.message {
                setActionStatus(msg)
            }
        default:
            break
        }
    }

    // MARK: — Private

    /// Show a short-lived confirmation (e.g. an auto-task ack), auto-clearing.
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
