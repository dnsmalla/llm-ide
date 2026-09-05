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
    /// Per-task settings + prompt templates from the Mac (`auto_task_setup_reply`).
    /// nil until the first snapshot arrives, so the editor can tell "not asked
    /// yet" from "asked, and the Mac has no project open".
    @Published var setup: AutoTaskSetupReply?

    private var actionStatusTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var logPollTask: Task<Void, Never>?
    /// Generation stamps so a cancelled polling loop can never clear the handle
    /// of the loop that replaced it (which used to spawn duplicate timers).
    private var pollGeneration = 0
    private var logPollGeneration = 0
    /// True once this run has auto-opened the run-log screen. Latches so the
    /// 1s/2s pollers can't re-present it after the user backs out.
    private var hasAutoPresentedRun = false

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
        hasAutoPresentedRun = false   // this run may auto-open the log once
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

    // MARK: — Setup (per-task settings + prompt templates)

    /// Ask the Mac for templates, per-task settings, skills, and folders. The
    /// Mac replies with `auto_task_setup_reply`, which lands in `setup`.
    func autoTaskSetupList() {
        connection?.sendEncodable(AutoTaskSetupList())
    }

    /// This task's saved settings, or an all-nil one when it has none.
    func config(for taskId: String) -> AutoTaskConfigInfo {
        setup?.configs.first { $0.taskId == taskId }
            ?? AutoTaskConfigInfo(taskId: taskId, inputPath: nil, outputPath: nil,
                                  skillName: nil, templateId: nil)
    }

    /// Replace one task's settings on the Mac. Carries the whole config, so a
    /// nil field clears that setting.
    func setConfig(_ config: AutoTaskConfigInfo) {
        send(AutoTaskConfigSet(taskId: config.taskId,
                               inputPath: config.inputPath,
                               outputPath: config.outputPath,
                               skillName: config.skillName,
                               templateId: config.templateId))
    }

    /// Create a template (`id == nil`) or overwrite an existing one's body.
    func saveTemplate(id: String?, name: String, body: String) {
        send(AutoTaskTemplateSave(id: id, name: name, body: body))
    }

    func deleteTemplate(id: String) {
        send(AutoTaskTemplateDelete(id: id))
    }

    /// Send a setup mutation. Every one of them is answered with a fresh
    /// snapshot by the Mac, so there is nothing to apply optimistically here.
    private func send<T: Encodable>(_ message: T) {
        lastError = nil
        guard connection?.sendEncodable(
            message,
            userFacing: true,
            onSendFailure: { [weak self] message in self?.handleSendFailure(message) }
        ) == true else {
            lastError = connection?.errorMessage ?? "Not connected to your Mac."
            return
        }
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
        // Consume the latch: the user chose to leave, so nothing may re-present
        // this run's log behind their back.
        hasAutoPresentedRun = true
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
        case "auto_task_setup_reply":
            if let reply = try? JSONDecoder().decode(AutoTaskSetupReply.self, from: data) {
                setup = reply
            } else {
                lastError = "Couldn't read the task setup from your Mac — tap refresh."
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

    /// Blank slate for a newly paired Mac — stop both pollers and drop the
    /// previous machine's task state, history and logs.
    func resetForNewDevice() {
        stopPolling()
        stopLogPolling()
        actionStatusTask?.cancel()
        actionStatusTask = nil
        hasAutoPresentedRun = false
        isRunLogPresented = false
        focusedLogTaskId = nil
        autoTaskState = nil
        autoTaskLogGroups = []
        autoTaskHistoryEntries = []
        setup = nil
        actionStatus = nil
        lastError = nil
    }

    // MARK: — Log polling

    /// Poll logs while a run is active or the log screen is open (Mac also pushes).
    func startLogPollingIfNeeded() {
        guard logPollTask == nil else { return }
        logPollGeneration &+= 1
        let generation = logPollGeneration
        logPollTask = Task { @MainActor [weak self] in
            // NO `defer { stopLogPolling() }`: a cancelled task doesn't finish
            // synchronously — it wakes from the sleep and runs its defer LATER,
            // by which time `logPollTask` may hold a NEWER task. The defer then
            // cancelled+nilled the successor's handle while it kept looping, and
            // the next start spawned a SECOND concurrent 1s loop. Clear the
            // handle only if this generation still owns it.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self, generation == self.logPollGeneration else { return }
                // A dropped socket used to leave this looping for the app's
                // lifetime: `isRunning` stays true in the stale snapshot, so
                // every tick issued a send that silently returned false.
                guard self.connection?.connectionStatus == .connected else {
                    self.clearLogPollTask(generation: generation)
                    return
                }
                let shouldPoll = self.isRunLogPresented || self.autoTaskState?.isRunning == true
                guard shouldPoll else {
                    self.clearLogPollTask(generation: generation)
                    return
                }
                self.autoTaskLogsList()
            }
        }
    }

    func stopLogPolling() {
        logPollGeneration &+= 1
        logPollTask?.cancel()
        logPollTask = nil
    }

    /// Release the handle only when this loop's generation still owns it.
    private func clearLogPollTask(generation: Int) {
        guard generation == logPollGeneration else { return }
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
        pollGeneration &+= 1
        let generation = pollGeneration
        pollTask = Task { @MainActor [weak self] in
            // See startLogPollingIfNeeded for why there is no `defer` here.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled, let self, generation == self.pollGeneration else { return }
                guard self.connection?.connectionStatus == .connected,
                      self.autoTaskState?.isRunning == true else {
                    self.clearPollTask(generation: generation)
                    return
                }
                self.autoTaskList()
            }
        }
    }

    private func stopPolling() {
        pollGeneration &+= 1
        pollTask?.cancel()
        pollTask = nil
    }

    private func clearPollTask(generation: Int) {
        guard generation == pollGeneration else { return }
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
        // Auto-present ONCE per run. Re-asserting it on every log reply meant
        // backing out during a run put the screen straight back within ~1s —
        // the user was trapped in the run log until the run finished.
        if reply.currentTask != nil, autoTaskState?.isRunning == true, !hasAutoPresentedRun {
            hasAutoPresentedRun = true
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
