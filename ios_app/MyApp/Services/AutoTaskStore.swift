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
    /// Per-task live logs — mirrors Mac `TaskLogStore` buffers.
    @Published var autoTaskLogGroups: [AutoTaskTaskLogs] = []
    /// Navigate to the live run-log screen after starting a task from iPhone.
    @Published var isRunLogPresented = false
    /// Which task tab to focus on the run-log screen (nil = follow Mac current).
    @Published var focusedLogTaskId: String?
    /// Transient confirmation of one-shot actions (auto-task acks); auto-clears.
    /// Read by the shell (`MobileHomeView`) for the action toast.
    @Published var actionStatus: String?
    /// Last auto-task wire error (e.g. Mac not configured).
    @Published var lastError: String?

    private var actionStatusTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var logPollTask: Task<Void, Never>?

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

    /// Ask the Mac for per-task live log buffers (`auto_task_logs_reply`).
    func autoTaskLogsList() {
        connection?.sendEncodable(AutoTaskLogsList())
    }

    /// Start the auto-task loop on the Mac. Pass a `task` id to scope it to
    /// one task, or nil to run all enabled tasks.
    func autoTaskRun(_ task: String? = nil) {
        lastError = nil
        focusedLogTaskId = task
        // Send BEFORE opening the log screen. Setting `isRunLogPresented` first
        // can trigger SwiftUI navigation/re-entrancy before the WebSocket frame
        // is queued — the Mac never sees the run and the log page looks empty.
        guard connection?.sendEncodable(
            AutoTaskRun(task: task),
            userFacing: true,
            onSendFailure: { [weak self] message in self?.handleSendFailure(message, dismissRunLog: true) }
        ) == true else {
            lastError = connection?.errorMessage ?? "Not connected to your Mac."
            return
        }
        seedLogGroupsFromState()
        autoTaskList()
        autoTaskLogsList()
        startLogPollingIfNeeded()
        isRunLogPresented = true
    }

    /// Stop the auto-task loop on the Mac.
    func autoTaskStop() {
        lastError = nil
        guard connection?.sendEncodable(
            AutoTaskStop(),
            userFacing: true,
            onSendFailure: { [weak self] message in self?.handleSendFailure(message) }
        ) == true else {
            lastError = connection?.errorMessage ?? "Not connected to your Mac."
            return
        }
        autoTaskList()
        autoTaskLogsList()
    }

    /// Toggle a single task's enabled flag, or the master switch when `task`
    /// is nil. The Mac replies with a fresh `auto_task_state`.
    func autoTaskToggle(task: String?, enabled: Bool) {
        lastError = nil
        guard connection?.sendEncodable(
            AutoTaskToggle(task: task, enabled: enabled),
            userFacing: true,
            onSendFailure: { [weak self] message in self?.handleSendFailure(message) }
        ) == true else {
            lastError = connection?.errorMessage ?? "Not connected to your Mac."
            return
        }
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
        autoTaskLogsList()
    }

    /// Open the run-log screen for an in-progress Mac run (e.g. from home card).
    func openRunLog(focusTask: String? = nil) {
        focusedLogTaskId = focusTask
        if autoTaskState == nil { autoTaskList() }
        seedLogGroupsFromState()
        autoTaskLogsList()
        startLogPollingIfNeeded()
        isRunLogPresented = true
    }

    /// Leave the run-log screen (Back). Do not call from `onDisappear` — SwiftUI
    /// can fire disappear during parent re-renders while the screen is still visible.
    func dismissRunLog() {
        isRunLogPresented = false
        stopLogPolling()
    }

    /// Run-log view appeared — keep polling even if `applyState` sees idle.
    func runLogViewDidAppear() {
        seedLogGroupsFromState()
        autoTaskLogsList()
        startLogPollingIfNeeded()
    }

    /// Run-log view disappeared — stop polling only when navigation actually closed.
    func runLogViewDidDisappear() {
        if !isRunLogPresented { stopLogPolling() }
    }

    // MARK: — Inbound (called by ConnectionService.receiveMessage dispatch)

    func handleInbound(type: String, data: Data) {
        switch type {
        case "auto_task_state":
            if let state = try? JSONDecoder().decode(AutoTaskState.self, from: data) {
                applyState(state)
            }
        case "auto_task_logs_reply":
            if let reply = try? JSONDecoder().decode(AutoTaskLogsReply.self, from: data) {
                applyLogReply(reply)
            } else {
                lastError = "Couldn't read auto-task logs from your Mac — tap refresh."
                seedLogGroupsFromState()
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
                    autoTaskLogsList()
                } else {
                    if let msg = ack.message {
                        lastError = msg
                        setActionStatus(msg)
                    }
                    autoTaskList()
                    autoTaskLogsList()
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

    /// WebSocket send failed after `sendEncodable` returned true (async error).
    func handleSendFailure(_ message: String, dismissRunLog: Bool = false) {
        lastError = message
        if dismissRunLog {
            isRunLogPresented = false
            stopLogPolling()
        }
    }

    func clearError() { lastError = nil }

    // MARK: — Log polling

    /// Poll logs while a run is active or the log screen is open (Mac also pushes).
    func startLogPollingIfNeeded() {
        guard logPollTask == nil else { return }
        logPollTask = Task { @MainActor [weak self] in
            defer { self?.stopLogPolling() }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                guard let self else { return }
                let shouldPoll = self.isRunLogPresented || self.autoTaskState?.isRunning == true
                guard shouldPoll else { return }
                self.autoTaskLogsList()
            }
        }
    }

    func stopLogPolling() {
        logPollTask?.cancel()
        logPollTask = nil
    }

    // MARK: — Private

    private func applyState(_ state: AutoTaskState) {
        autoTaskState = state
        seedLogGroupsFromState()
        if state.isRunning {
            startPollingIfNeeded()
            startLogPollingIfNeeded()
            if focusedLogTaskId == nil, let current = state.currentTask {
                focusedLogTaskId = current
            }
        } else {
            stopPolling()
            // Keep fetching logs while the run-log screen is open (run may have
            // just finished and the Mac is still flushing TaskLogStore).
            if !isRunLogPresented { stopLogPolling() }
            autoTaskHistory()
            autoTaskLogsList()
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

    private func applyLogReply(_ reply: AutoTaskLogsReply) {
        autoTaskLogGroups = reply.tasks
        if focusedLogTaskId == nil, let current = reply.currentTask {
            focusedLogTaskId = current
        }
        if reply.currentTask != nil, autoTaskState?.isRunning == true {
            isRunLogPresented = true
        }
        // Mac always sends all task buckets; if decode succeeded but tasks is
        // empty, fall back to the last known state snapshot.
        if autoTaskLogGroups.isEmpty {
            seedLogGroupsFromState()
        }
    }

    private func seedLogGroupsFromState() {
        guard let tasks = autoTaskState?.tasks, !tasks.isEmpty else { return }
        if autoTaskLogGroups.isEmpty {
            autoTaskLogGroups = tasks.map { AutoTaskTaskLogs(id: $0.id, label: $0.label, lines: []) }
            return
        }
        let existing = Dictionary(uniqueKeysWithValues: autoTaskLogGroups.map { ($0.id, $0) })
        let merged = tasks.map { task in
            if let group = existing[task.id] {
                return AutoTaskTaskLogs(id: task.id, label: task.label, lines: group.lines)
            }
            return AutoTaskTaskLogs(id: task.id, label: task.label, lines: [])
        }
        if merged.map(\.id) != autoTaskLogGroups.map(\.id) {
            autoTaskLogGroups = merged
        }
    }
}
