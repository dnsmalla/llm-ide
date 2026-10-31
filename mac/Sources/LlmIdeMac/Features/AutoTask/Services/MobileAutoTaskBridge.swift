import Combine
import Foundation

/// Serves the `auto_task_*` slice of the mobile protocol on behalf of the
/// mobile manager — see `MobileFeatureBridge`'s doc comment for why the
/// manager holds this behind a protocol rather than this concrete type.
///
/// Lives in Features/AutoTask, not Features/MobileControl: it is Auto Tasks'
/// half of the phone seam. It reaches the manager only through
/// `MobileBridgeHosting` (Core/Contracts), so it names no MobileControl type
/// and needs no `SharedProtocol` import — the host decodes
/// `MobileAutoTaskRequest` from the wire and encodes `MobileAutoTaskReply`
/// back onto it. That is what lets this file compile in a build with
/// `auto_tasks` on and `mobile_sync` off, where `SharedProtocol` is not linked.
///
/// The `mobileClientPaired`-gated push helpers keep their guard so a
/// desktop-side change sends nothing while no phone is listening.
@MainActor
final class MobileAutoTaskBridge: MobileFeatureBridge {
    weak var host: (any MobileBridgeHosting)?
    var autoCode: AutoCodeUpdateService?
    var settings: AutoTaskSettings?
    var logStore: TaskLogStore?

    private var cancellables = Set<AnyCancellable>()

    init(host: any MobileBridgeHosting, autoCode: AutoCodeUpdateService,
         settings: AutoTaskSettings, logStore: TaskLogStore) {
        self.host = host
        self.autoCode = autoCode
        self.settings = settings
        self.logStore = logStore
    }

    /// Custom tasks of the ACTIVE project only (same scoping as
    /// `AutoCodeUpdateService.dueCustomTasks`); no active project → none.
    func scopedCustomTasks() -> [CustomAutoTask] {
        Self.customTasks(activeProjectId: autoCode?.projectStore?.activeProject?.bundle.id,
                         defaults: autoCode?.config.userDefaults ?? .standard)
    }

    static func customTasks(activeProjectId: String?, defaults: UserDefaults) -> [CustomAutoTask] {
        guard let activeProjectId else { return [] }
        CustomAutoTask.adoptLegacyTasks(into: activeProjectId, in: defaults)
        return CustomAutoTask.loadAll(forProject: activeProjectId, from: defaults)
    }

    // MARK: - MobileFeatureBridge

    /// Handle `auto_task_*` messages: list / toggle / run / stop / history for
    /// the Auto Task scheduler, plus the setup channel. The `autoCode`/`settings`
    /// deps are @MainActor like the manager. `host?.replyNotConfigured(commandId:logLabel:)`
    /// mirrors a `CommandError` when the wiring is absent so the phone shows a
    /// concrete reason. `data` is optional so a manager-triggered synthetic
    /// call (e.g. an immediate push right after pairing) can pass `nil` for
    /// message types that never decode a payload.
    func handle(type: String, data: Data?) -> Bool {
        guard let request = host?.decodeAutoTaskRequest(type: type, data: data) else {
            host?.logInfo("Unhandled auto-task type: \(type)")
            return false
        }
        switch request {
        case .list:
            // Snapshot the current Auto Task scheduler + per-task state. Both
            // deps are @MainActor like this bridge, so the reads below are
            // isolation-safe. Missing wiring → a CommandError so the phone
            // shows a concrete reason instead of an unanswered request.
            guard let state = buildAutoTaskState() else {
                host?.replyNotConfigured(commandId: "auto_task", logLabel: "auto_task_list")
                return true
            }
            host?.logInfo("Auto-task state: \(state.isRunning ? "running" : "idle"), master=\(state.masterEnabled)")
            host?.sendAutoTaskReply(.state(state))
            return true

        case .toggle:
            // Desktop-only: a toggle changes what the scheduler runs next, so the phone may read the
            // flags (state/list) but not flip them. The reply is a typed refusal, never a crash, so an
            // older phone that still shows the switch just gets its message.
            refuseDesktopOnly(commandId: "auto_task_toggle", what: "Turning Auto Tasks on or off")
            replyAutoTaskStateOrAck()
            return true

        case .run(let run):
            // Trigger a global run (task == nil) or a single per-task manual
            // run. `runNow()`/`runSingle(_:)` are @MainActor-sync — each spins
            // its own internal `Task` — so no await is needed; we're already
            // on the main actor here (handleInbound is main-isolated).
            guard controlAllowed else {
                host?.sendAutoTaskReply(.ack(ok: false, message: controlDeniedMessage))
                return true
            }
            guard let ac = autoCode else {
                host?.replyNotConfigured(commandId: "auto_task_run", logLabel: "auto_task_run")
                return true
            }
            if let m = run {
                // Four-way branch, mirroring the toggle handler above:
                // built-in task / custom task / no task = global run / an
                // unrecognized non-nil id (e.g. the phone still shows a
                // since-deleted custom task) — the last case must NOT fall
                // through to a global run-all, which would be a surprising
                // and wrong response to "run this one specific task".
                var started = false
                var unrecognized = false
                // A phone run honours the task's OWN enable flag. It used to ignore it, so a phone with
                // Auto Task control on could start implement/review-merge although both were off on the Mac.
                if let raw = m.task, let t = AutoTask(rawValue: raw), !ac.isTaskEnabled(t) {
                    refuseDisabled(label: t.label, id: t.rawValue)
                    return true
                }
                if let raw = m.task, AutoTask(rawValue: raw) == nil,
                   let custom = scopedCustomTasks().first(where: { $0.id == raw }), !custom.isEnabled {
                    refuseDisabled(label: custom.name, id: custom.id)
                    return true
                }
                if let raw = m.task, let t = AutoTask(rawValue: raw) {
                    started = ac.runSingle(t, trigger: .phone)
                    if started {
                        host?.logInfo("Auto-task run single: \(t.rawValue)")
                    }
                } else if let raw = m.task,
                          let custom = scopedCustomTasks().first(where: { $0.id == raw }) {
                    started = ac.runSingleCustom(custom, trigger: .phone)
                    if started {
                        host?.logInfo("Custom auto-task run: \(custom.name)")
                    }
                } else if m.task == nil {
                    started = ac.runNow(trigger: .phone)
                    if started {
                        host?.logInfo("Auto-task run now")
                    }
                } else {
                    unrecognized = true
                    host?.logError("auto_task_run: unknown task id \(m.task ?? "?")")
                }
                if unrecognized {
                    host?.replyCommandError(commandId: "auto_task_run",
                                            message: "That task no longer exists on your Mac. Refresh the task list.")
                } else if started {
                    replyAutoTaskStateOrAck()
                } else {
                    host?.logInfo("Auto-task run ignored — already running on Mac")
                    host?.sendAutoTaskReply(.ack(ok: false,
                                                 message: "Auto Tasks is already running on your Mac. Tap Stop first."))
                }
            } else {
                host?.logDecodeFailure(type: type, data: data)
                host?.replyCommandError(commandId: "auto_task_run",
                                        message: "Invalid auto-task run request from phone.")
            }
            return true

        case .stop:
            // `cancel()` is @MainActor-sync: cancels the in-flight `runTask`
            // and terminates the active subprocess. No-op when idle; nil-safe
            // via `?` (no wiring → ack still replies, phone doesn't hang).
            autoCode?.cancel()
            host?.logInfo("Auto-task stop")
            replyAutoTaskStateOrAck()
            return true

        case .history:
            // Snapshot the processed-actions registry. `allEntries` is
            // @Published on AutoCodeUpdateService (a cached copy of
            // Registry.allEntries()), so the read is cheap and main-isolated.
            // `actionText` is free text lifted from meeting notes / tickets and
            // can carry pasted tokens, so it is redacted like the log tail —
            // off the main actor, as the redactor requires.
            let raw = (autoCode?.allEntries ?? []).map {
                (text: $0.actionText, status: $0.status.rawValue,
                 lastUpdated: $0.lastUpdated.timeIntervalSince1970)
            }
            // No host means no phone to send to; never fall back to raw text.
            let redact = host?.phoneTextRedactor ?? { _ in "" }
            Task { [weak self] in
                let entries = await Task.detached(priority: .userInitiated) {
                    raw.map {
                        MobileAutoTaskReply.HistoryEntry(actionText: redact($0.text),
                                                         status: $0.status,
                                                         lastUpdated: $0.lastUpdated)
                    }
                }.value
                self?.host?.logInfo("Auto-task history: \(entries.count) entries")
                self?.host?.sendAutoTaskReply(.history(entries))
            }
            return true

        case .logsList:
            if let logs = buildAutoTaskLogsReply() {
                host?.logInfo("Auto-task logs: \(logs.tasks.count) task buffer(s), \(logs.tasks.reduce(0) { $0 + $1.lines.count }) line(s)")
                host?.sendAutoTaskReply(.logs(logs))
            } else {
                host?.replyNotConfigured(commandId: "auto_task_logs", logLabel: "auto_task_logs_list")
            }
            return true

        case .setupList, .configSet, .templateSave, .templateRename, .templateDelete:
            handleAutoTaskSetup(request, type: type, data: data)
            return true
        }
    }

    /// Subscribe to Mac-side Auto Task changes and push snapshots to a paired
    /// iPhone without waiting for a pull request. Called once by the mobile
    /// manager when it installs its own push observers.
    func installPushObservers() {
        cancellables.removeAll()

        autoCode?.objectWillChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.pushAutoTaskStateIfPaired() }
            .store(in: &cancellables)

        settings?.objectWillChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.pushAutoTaskStateIfPaired() }
            .store(in: &cancellables)

        logStore?.objectWillChange
            .debounce(for: .milliseconds(250), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.pushAutoTaskLogsIfPaired() }
            .store(in: &cancellables)

        // Per-task settings and the template library are edited on BOTH sides.
        // `AutoTaskConfigSet` replaces a task's whole config, so a phone
        // holding a snapshot taken before a desktop edit would silently undo
        // it on its next write. Pushing on change keeps that window to the
        // debounce interval instead of "until the user pulls to refresh".
        autoCode?.taskConfigs.objectWillChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.pushAutoTaskSetupIfPaired() }
            .store(in: &cancellables)

        // `templatesDidChange`, NOT `objectWillChange`: the store also publishes
        // the unsaved editor draft, so subscribing to the object would run two
        // directory scans and push a snapshot on every pause while someone
        // types a prompt on the Mac — for a payload that had not changed.
        autoCode?.autoTaskTemplates?.templatesDidChange
            .debounce(for: .milliseconds(350), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.pushAutoTaskSetupIfPaired() }
            .store(in: &cancellables)
    }

    /// Cancel every subscription `installPushObservers()` stored, mirroring
    /// the manager's own `mobilePushCancellables.removeAll()` in `stop()`.
    func removePushObservers() {
        cancellables.removeAll()
    }

    // MARK: - Auto-task setup (per-task settings + prompt templates)

    /// Handle the `auto_task_setup_*` / `auto_task_config_*` /
    /// `auto_task_template_*` messages — the phone's half of the Mac's Auto
    /// Task Settings and Template cards.
    ///
    /// Every mutation ends by replying with a fresh `AutoTaskSetupReply` rather
    /// than an ack: a template rename can CHANGE the template's id (the id is
    /// the filename stem) and repoint other tasks' configs, so an ack would
    /// leave the phone holding state the Mac has already moved past.
    private func handleAutoTaskSetup(_ request: MobileAutoTaskRequest, type: String, data: Data?) {
        switch request {
        case .configSet, .templateSave, .templateRename, .templateDelete:
            // Desktop-only. These edit what a later run executes (a template body is a prompt, a config's
            // paths and skill end up in one a `.implement` task acts on), so the phone may read but never
            // write them, whatever the Auto Task switch says. A typed refusal, never a crash, for old
            // phones; answered before any wiring check so it never depends on the Mac's state.
            refuseDesktopOnly(commandId: type, what: "Editing Auto Task settings and templates")
            return
        case .setupList:
            break   // read-only snapshot: the phone keeps read access to templates and per-task config
        case .list, .toggle, .run, .stop, .history, .logsList:
            // Not a setup message; `handle` never routes these here.
            host?.logInfo("Unhandled auto-task setup type: \(type)")
            return
        }
        guard let autoCode, autoCode.autoTaskTemplates != nil else {
            host?.replyNotConfigured(commandId: "auto_task_setup", logLabel: type)
            return
        }
        if let templates = autoCode.autoTaskTemplates {
            replyAutoTaskSetup(autoCode: autoCode, templates: templates)
        }
    }

    /// Typed `desktop_only` refusal: the action exists only on the Mac.
    private func refuseDesktopOnly(commandId: String, what: String) {
        host?.logInfo("\(commandId) refused: desktop-only")
        host?.replyCommandError(commandId: commandId,
                                message: "\(what) is only available on your Mac.",
                                code: MobileRefusalCode.desktopOnly)
    }

    /// Typed refusal for a phone run of a task that is switched off on the Mac.
    private func refuseDisabled(label: String, id: String) {
        host?.logInfo("auto_task_run refused: \(id) is disabled on the Mac")
        host?.sendAutoTaskReply(.ack(
            ok: false,
            message: "\(label) is turned off on your Mac. Turn it on there to run it from the phone.",
            code: MobileRefusalCode.taskDisabled))
    }

    /// Re-read on every request: a phone may hold an old capability list after the switch flips off.
    /// Fails closed: no host means no switch to consult.
    private var controlAllowed: Bool {
        host?.isPhoneAccessAllowed(.autoTaskControl) == true
    }

    private var controlDeniedMessage: String {
        host?.phoneAccessDeniedMessage(.autoTaskControl) ?? ""
    }

    /// Build and send the setup snapshot.
    ///
    /// The two catalog scans walk the project's directories, so they run off
    /// the main actor — this is reached after EVERY setup message, not just the
    /// list request, and a 400-directory enumeration on the main thread would
    /// stutter the Mac UI on each tap of the phone's picker.
    private func replyAutoTaskSetup(autoCode: AutoCodeUpdateService,
                                    templates: AutoTaskTemplateStore) {
        let root = host?.projectStore?.activeProject.map { URL(fileURLWithPath: $0.localPath) }
        Task { [weak self] in
            let scanned = await Task.detached(priority: .userInitiated) {
                (skills: root.map { AutoTaskSkillCatalog.scan(projectRoot: $0) } ?? [],
                 folders: AutoTaskFolderCatalog.scan(projectRoot: root))
            }.value
            guard let self else { return }
            self.host?.sendAutoTaskReply(.setup(self.buildAutoTaskSetupReply(
                autoCode: autoCode, templates: templates, root: root,
                skills: scanned.skills, folders: scanned.folders)))
        }
    }

    private func buildAutoTaskSetupReply(autoCode: AutoCodeUpdateService,
                                         templates: AutoTaskTemplateStore,
                                         root: URL?,
                                         skills: [AutoTaskSkillCatalog.Entry],
                                         folders: [AutoTaskFolderCatalog.Folder]) -> MobileAutoTaskReply.Setup {
        MobileAutoTaskReply.Setup(
            hasProject: root != nil,
            projectName: host?.projectStore?.activeProject?.bundle.displayName,
            templates: templates.templates.map {
                MobileAutoTaskReply.Template(id: $0.id, name: $0.name, body: $0.body)
            },
            configs: autoCode.taskConfigs.configs.map { taskId, config in
                MobileAutoTaskReply.TaskConfig(taskId: taskId, inputPath: config.inputPath,
                                               outputPath: config.outputPath,
                                               skillName: config.skillName,
                                               templateId: config.templateId)
            }.sorted { $0.taskId < $1.taskId },
            skills: skills.map { MobileAutoTaskReply.Skill(name: $0.name, description: $0.description) },
            folders: folders.map(\.path))
    }

    // MARK: - State snapshot + push helpers

    /// Build the wire snapshot the iPhone mirrors. Returns nil when the Auto
    /// Task stack isn't wired (previews / tests).
    private func buildAutoTaskState() -> MobileAutoTaskReply.State? {
        guard let ac = autoCode, let s = settings else { return nil }
        // The template warning rides in `lastError` when there is no real error,
        // so the phone also learns its edited template is being ignored.
        let allInfos = AutoTask.allCases.map { t in
            MobileAutoTaskReply.TaskInfo(id: t.rawValue, label: t.label,
                         enabled: s.isEnabled(task: t),
                         lastError: ac.taskErrors[t.rawValue] ?? ac.visibleTemplateWarning(for: t.rawValue))
        }
        let customInfos = scopedCustomTasks().map { t in
            MobileAutoTaskReply.TaskInfo(id: t.id, label: t.name, enabled: t.isEnabled,
                         lastError: ac.taskErrors[t.id] ?? ac.visibleTemplateWarning(for: t.id))
        }
        // Mirror the Mac "Show only enabled" filter: when on, the phone sees
        // only the active task set (re-enabling a hidden task is done on Mac).
        // Custom tasks participate identically to built-ins.
        let combined = allInfos + customInfos
        let infos = s.showOnlyEnabledTasks ? combined.filter { $0.enabled } : combined
        return MobileAutoTaskReply.State(masterEnabled: s.enabled,
                             isRunning: ac.isRunning || ac.hasScheduledRun,
                             currentTask: ac.currentTask?.rawValue ?? ac.currentCustomTaskId,
                             currentStep: ac.currentStep,
                             statusMessage: ac.statusMessage,
                             lastRunDate: ac.lastRunDate?.timeIntervalSince1970,
                             createdCount: ac.createdCount,
                             implementedCount: ac.implementedCount,
                             failedCount: ac.failedCount,
                             tasks: infos)
    }

    /// After run/stop/toggle the phone needs a fresh snapshot — not just a bare
    /// ack — so execution status mirrors the Mac without a manual refresh.
    private func replyAutoTaskStateOrAck() {
        if let state = buildAutoTaskState() {
            host?.sendAutoTaskReply(.state(state))
            pushAutoTaskLogsIfPaired()
        } else {
            host?.sendAutoTaskReply(.ack(ok: true, message: nil))
        }
    }

    /// Build the wire snapshot of per-task live logs for the iPhone run screen.
    private func buildAutoTaskLogsReply() -> MobileAutoTaskReply.Logs? {
        guard let logStore else { return nil }
        // No host means no phone to send to; never fall back to raw text.
        let redact = host?.phoneTextRedactor ?? { _ in "" }
        let current = autoCode?.currentTask?.rawValue ?? autoCode?.currentCustomTaskId
        let builtIn = AutoTask.allCases.map { task in
            let lines = logStore.lines(for: task).map { line in
                MobileAutoTaskReply.LogLine(id: line.id.uuidString,
                                            timestamp: line.timestamp.timeIntervalSince1970,
                                            level: line.level.rawValue,
                                            text: redact(line.text))
            }
            return MobileAutoTaskReply.TaskLogs(id: task.rawValue, label: task.label, lines: lines)
        }
        let custom = scopedCustomTasks().map { task in
            let lines = logStore.lines(for: task.id).map { line in
                MobileAutoTaskReply.LogLine(id: line.id.uuidString,
                                            timestamp: line.timestamp.timeIntervalSince1970,
                                            level: line.level.rawValue,
                                            text: redact(line.text))
            }
            return MobileAutoTaskReply.TaskLogs(id: task.id, label: task.name, lines: lines)
        }
        return MobileAutoTaskReply.Logs(currentTask: current, tasks: builtIn + custom)
    }

    private func pushAutoTaskStateIfPaired() {
        guard host?.mobileClientPaired == true, let state = buildAutoTaskState() else { return }
        host?.sendAutoTaskReply(.state(state))
    }

    /// Push the per-task settings + template snapshot after a desktop-side
    /// change, so the phone's next `AutoTaskConfigSet` (a whole-config
    /// replace) is built on current state rather than a stale one.
    private func pushAutoTaskSetupIfPaired() {
        guard host?.mobileClientPaired == true, let autoCode,
              let templates = autoCode.autoTaskTemplates else { return }
        replyAutoTaskSetup(autoCode: autoCode, templates: templates)
    }

    private func pushAutoTaskLogsIfPaired() {
        guard host?.mobileClientPaired == true, let logs = buildAutoTaskLogsReply() else { return }
        host?.sendAutoTaskReply(.logs(logs))
    }
}
