import Combine
import Foundation
import SharedProtocol

/// Serves the `auto_task_*` slice of the mobile protocol on behalf of
/// `MobileControlManager` — see `MobileFeatureBridge`'s doc comment for why
/// the manager holds this behind a protocol rather than this concrete type.
///
/// Every method below is the pre-split `MobileControlManager` body moved
/// verbatim (Phase 2c Task 1): `self`-implicit references to the manager's
/// `append`/`reply`/`replyNotConfigured`/`decoder`/`mobileClientPaired` became
/// `manager?.`-qualified, and the old `autoCode`/`autoTaskSettings`/`logStore`
/// manager properties became this bridge's own stored refs (`autoTaskSettings`
/// renamed to `settings` to match the initializer's parameter label). The
/// `mobileClientPaired`-gated push helpers keep the exact original guard so
/// their behavior is unchanged by the split.
@MainActor
final class MobileAutoTaskBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    var autoCode: AutoCodeUpdateService?
    var settings: AutoTaskSettings?
    var logStore: TaskLogStore?

    private var cancellables = Set<AnyCancellable>()

    init(manager: MobileControlManager, autoCode: AutoCodeUpdateService,
         settings: AutoTaskSettings, logStore: TaskLogStore) {
        self.manager = manager
        self.autoCode = autoCode
        self.settings = settings
        self.logStore = logStore
    }

    // MARK: - MobileFeatureBridge

    /// Handle `auto_task_*` messages: list / toggle / run / stop / history for
    /// the Auto Task scheduler. Each case is the pre-existing body moved
    /// verbatim from the old monolithic `handleInbound` switch (by way of
    /// `MobileControlManager.handleAutoTask`); the `autoCode`/`settings` deps
    /// are @MainActor like the manager. `manager?.replyNotConfigured(commandId:logLabel:)`
    /// mirrors a `CommandError` when the wiring is absent so the phone shows a
    /// concrete reason. `data` is optional so a manager-triggered synthetic
    /// call (e.g. an immediate push right after pairing) can pass `nil` for
    /// message types that never decode a payload.
    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.autoTaskList:
            // Snapshot the current Auto Task scheduler + per-task state. Both
            // deps are @MainActor like this manager, so the reads below are
            // isolation-safe. Missing wiring → a CommandError so the phone
            // shows a concrete reason instead of an unanswered request.
            guard let state = buildAutoTaskState() else {
                manager?.replyNotConfigured(commandId: "auto_task", logLabel: "auto_task_list")
                return true
            }
            manager?.append(.info, "Auto-task state: \(state.isRunning ? "running" : "idle"), master=\(state.masterEnabled)")
            manager?.reply(state)
            return true

        case MobileProtocol.Tag.autoTaskToggle:
            // Flip the master enable (task == nil), a built-in per-task flag,
            // or (new) a custom task's isEnabled. Routes through
            // AutoTaskSettings.setEnabled / .enabled for built-ins so the
            // @Published didSet persists + arms/disarms the scheduler exactly
            // as the on-Mac Settings toggle would; custom tasks persist via
            // CustomAutoTask.save() directly (they have no AutoTaskSettings
            // entry — enabled-state lives on the struct itself).
            if let m = try? manager?.decoder.decode(AutoTaskToggle.self, from: data ?? Data()) {
                if let taskName = m.task, let t = AutoTask(rawValue: taskName) {
                    settings?.setEnabled(m.enabled, task: t)
                    manager?.append(.info, "Auto-task toggle \(t.rawValue)=\(m.enabled)")
                } else if let taskName = m.task,
                          var custom = CustomAutoTask.loadAll().first(where: { $0.id == taskName }) {
                    custom.isEnabled = m.enabled
                    custom.save()
                    NotificationCenter.default.post(name: .customAutoTasksChanged, object: nil)
                    manager?.append(.info, "Custom auto-task toggle \(custom.name)=\(m.enabled)")
                } else if m.task == nil {
                    guard FeatureRegistry.shared.isEnabled(.autoTasks) else {
                        manager?.append(.info, "Auto-task master toggle ignored: feature disabled on Mac")
                        replyAutoTaskStateOrAck()
                        return true
                    }
                    settings?.enabled = m.enabled
                    manager?.append(.info, "Auto-task master=\(m.enabled)")
                } else {
                    manager?.append(.stderr, "auto_task_toggle: unknown task id \(m.task ?? "?")")
                }
                replyAutoTaskStateOrAck()
            } else {
                let preview = String(data: data ?? Data(), encoding: .utf8)?.prefix(100) ?? "<binary>"
                manager?.append(.stderr, "auto_task_toggle decode failed: \(preview)")
                manager?.reply(CommandError(commandId: "auto_task_toggle",
                                            message: "Invalid auto-task toggle request from phone."))
            }
            return true

        case MobileProtocol.Tag.autoTaskRun:
            // Trigger a global run (task == nil) or a single per-task manual
            // run. `runNow()`/`runSingle(_:)` are @MainActor-sync — each spins
            // its own internal `Task` — so no await is needed; we're already
            // on the main actor here (handleInbound is main-isolated).
            guard let ac = autoCode else {
                manager?.replyNotConfigured(commandId: "auto_task_run", logLabel: "auto_task_run")
                return true
            }
            if let m = try? manager?.decoder.decode(AutoTaskRun.self, from: data ?? Data()) {
                // Four-way branch, mirroring the toggle handler above:
                // built-in task / custom task / no task = global run / an
                // unrecognized non-nil id (e.g. the phone still shows a
                // since-deleted custom task) — the last case must NOT fall
                // through to a global run-all, which would be a surprising
                // and wrong response to "run this one specific task".
                var started = false
                var unrecognized = false
                if let raw = m.task, let t = AutoTask(rawValue: raw) {
                    started = ac.runSingle(t, trigger: .phone)
                    if started {
                        manager?.append(.info, "Auto-task run single: \(t.rawValue)")
                    }
                } else if let raw = m.task,
                          let custom = CustomAutoTask.loadAll().first(where: { $0.id == raw }) {
                    started = ac.runSingleCustom(custom, trigger: .phone)
                    if started {
                        manager?.append(.info, "Custom auto-task run: \(custom.name)")
                    }
                } else if m.task == nil {
                    started = ac.runNow(trigger: .phone)
                    if started {
                        manager?.append(.info, "Auto-task run now")
                    }
                } else {
                    unrecognized = true
                    manager?.append(.stderr, "auto_task_run: unknown task id \(m.task ?? "?")")
                }
                if unrecognized {
                    manager?.reply(CommandError(commandId: "auto_task_run",
                                                message: "That task no longer exists on your Mac. Refresh the task list."))
                } else if started {
                    replyAutoTaskStateOrAck()
                } else {
                    manager?.append(.info, "Auto-task run ignored — already running on Mac")
                    manager?.reply(AutoTaskAck(ok: false,
                                               message: "Auto Tasks is already running on your Mac. Tap Stop first."))
                }
            } else {
                let preview = String(data: data ?? Data(), encoding: .utf8)?.prefix(100) ?? "<binary>"
                manager?.append(.stderr, "auto_task_run decode failed: \(preview)")
                manager?.reply(CommandError(commandId: "auto_task_run",
                                            message: "Invalid auto-task run request from phone."))
            }
            return true

        case MobileProtocol.Tag.autoTaskStop:
            // `cancel()` is @MainActor-sync: cancels the in-flight `runTask`
            // and terminates the active subprocess. No-op when idle; nil-safe
            // via `?` (no wiring → ack still replies, phone doesn't hang).
            autoCode?.cancel()
            manager?.append(.info, "Auto-task stop")
            replyAutoTaskStateOrAck()
            return true

        case MobileProtocol.Tag.autoTaskHistory:
            // Snapshot the processed-actions registry. `allEntries` is
            // @Published on AutoCodeUpdateService (a cached copy of
            // Registry.allEntries()), so the read is cheap and main-isolated.
            let entries = (autoCode?.allEntries ?? []).map {
                AutoTaskHistoryEntry(actionText: $0.actionText,
                                     status: $0.status.rawValue,
                                     lastUpdated: $0.lastUpdated.timeIntervalSince1970)
            }
            manager?.append(.info, "Auto-task history: \(entries.count) entries")
            manager?.reply(AutoTaskHistoryReply(entries: entries))
            return true

        case MobileProtocol.Tag.autoTaskLogsList:
            if let logs = buildAutoTaskLogsReply() {
                manager?.append(.info, "Auto-task logs: \(logs.tasks.count) task buffer(s), \(logs.tasks.reduce(0) { $0 + $1.lines.count }) line(s)")
                manager?.reply(logs)
            } else {
                manager?.replyNotConfigured(commandId: "auto_task_logs", logLabel: "auto_task_logs_list")
            }
            return true

        case MobileProtocol.Tag.autoTaskSetupList,
             MobileProtocol.Tag.autoTaskConfigSet,
             MobileProtocol.Tag.autoTaskTemplateSave,
             MobileProtocol.Tag.autoTaskTemplateRename,
             MobileProtocol.Tag.autoTaskTemplateDelete:
            handleAutoTaskSetup(type: type, data: data)
            return true

        default:
            manager?.append(.info, "Unhandled auto-task type: \(type)")
            return false
        }
    }

    /// Subscribe to Mac-side Auto Task changes and push snapshots to a paired
    /// iPhone without waiting for a pull request. Moved verbatim from
    /// `MobileControlManager.installMobilePushObservers` (the auto-task
    /// slice); called once from the manager's own `installMobilePushObservers`.
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

    // MARK: - Auto-task setup (per-task settings + prompt templates)

    /// Handle the `auto_task_setup_*` / `auto_task_config_*` /
    /// `auto_task_template_*` messages — the phone's half of the Mac's Auto
    /// Task Settings and Template cards.
    ///
    /// Every mutation ends by replying with a fresh `AutoTaskSetupReply` rather
    /// than an ack: a template rename can CHANGE the template's id (the id is
    /// the filename stem) and repoint other tasks' configs, so an ack would
    /// leave the phone holding state the Mac has already moved past.
    private func handleAutoTaskSetup(type: String, data: Data?) {
        guard let autoCode, let templates = autoCode.autoTaskTemplates else {
            manager?.replyNotConfigured(commandId: "auto_task_setup", logLabel: type)
            return
        }

        switch type {
        case MobileProtocol.Tag.autoTaskSetupList:
            break   // snapshot only — fall through to the reply below

        case MobileProtocol.Tag.autoTaskConfigSet:
            guard let m = try? manager?.decoder.decode(AutoTaskConfigSet.self, from: data ?? Data()) else {
                replyAutoTaskSetupDecodeFailure(type: type, data: data)
                return
            }
            // The phone is a second writer into the Mac's settings, so its
            // input is validated rather than trusted. An unknown task id would
            // create a record no Mac surface can reach or delete, and the paths
            // end up in a prompt that a `.implement` task acts on — so both are
            // checked before anything is stored.
            guard isKnownAutoTaskId(m.taskId) else {
                manager?.append(.stderr, "auto_task_config_set: unknown task id \(m.taskId)")
                manager?.reply(CommandError(commandId: "auto_task_config_set",
                                            message: "That task no longer exists on your Mac. Refresh the task list."))
                return
            }
            guard let inputPath = validatedProjectPath(m.inputPath),
                  let outputPath = validatedProjectPath(m.outputPath) else {
                manager?.append(.stderr, "auto_task_config_set: rejected a path outside the project")
                manager?.reply(CommandError(commandId: "auto_task_config_set",
                                            message: "Paths must be folders inside the open project."))
                return
            }
            // Routed through the same store the Mac page writes to, so the
            // desktop UI updates live and the value persists identically.
            autoCode.taskConfigs.update(
                AutoTaskConfig(inputPath: inputPath, outputPath: outputPath,
                               skillName: m.skillName,
                               skillDirective: m.skillName.map { AutoTaskSkillCatalog.directive(for: $0) },
                               templateId: m.templateId),
                for: m.taskId)
            manager?.append(.info, "Auto-task config set for \(m.taskId)")

        case MobileProtocol.Tag.autoTaskTemplateSave:
            guard let m = try? manager?.decoder.decode(AutoTaskTemplateSave.self, from: data ?? Data()) else {
                replyAutoTaskSetupDecodeFailure(type: type, data: data)
                return
            }
            guard let id = m.id else {
                guard templates.create(name: m.name, body: m.body) != nil else {
                    manager?.reply(CommandError(commandId: "auto_task_template_save",
                                                message: "Could not create “\(m.name)” — is a project open on your Mac?"))
                    return
                }
                manager?.append(.info, "Auto-task template created: \(m.name)")
                break
            }
            // Body and name are applied HERE, in one message, because a rename
            // moves the file and changes the id: two frames would race, and a
            // rename serviced first would make the body write target a file
            // that no longer exists.
            guard templates.update(id: id, body: m.body) else {
                manager?.reply(CommandError(commandId: "auto_task_template_save",
                                            message: "Could not save “\(m.name)” on your Mac."))
                return
            }
            let trimmedName = m.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedName.isEmpty, templates.template(id: id)?.name != trimmedName,
               templates.rename(id: id, to: trimmedName) == nil {
                manager?.reply(CommandError(commandId: "auto_task_template_save",
                                            message: "Saved “\(m.name)”, but could not rename it."))
                return
            }
            manager?.append(.info, "Auto-task template saved: \(id)")

        case MobileProtocol.Tag.autoTaskTemplateRename:
            guard let m = try? manager?.decoder.decode(AutoTaskTemplateRename.self, from: data ?? Data()) else {
                replyAutoTaskSetupDecodeFailure(type: type, data: data)
                return
            }
            guard templates.rename(id: m.id, to: m.name) != nil else {
                manager?.reply(CommandError(commandId: "auto_task_template_rename",
                                            message: "Could not rename that template on your Mac."))
                return
            }
            manager?.append(.info, "Auto-task template renamed: \(m.id) → \(m.name)")

        case MobileProtocol.Tag.autoTaskTemplateDelete:
            guard let m = try? manager?.decoder.decode(AutoTaskTemplateDelete.self, from: data ?? Data()) else {
                replyAutoTaskSetupDecodeFailure(type: type, data: data)
                return
            }
            guard templates.delete(id: m.id) else {
                manager?.reply(CommandError(commandId: "auto_task_template_delete",
                                            message: "Could not delete that template on your Mac."))
                return
            }
            manager?.append(.info, "Auto-task template deleted: \(m.id)")

        default:
            manager?.append(.info, "Unhandled auto-task setup type: \(type)")
            return
        }

        replyAutoTaskSetup(autoCode: autoCode, templates: templates)
    }

    /// True for a built-in task or a custom task that currently exists.
    private func isKnownAutoTaskId(_ id: String) -> Bool {
        AutoTask(rawValue: id) != nil || CustomAutoTask.loadAll().contains { $0.id == id }
    }

    /// `.some(path)` when the value is a project-relative folder inside the
    /// open project (or nil, meaning "not set"); `.none` when it escapes.
    ///
    /// Double optional by design: the caller must distinguish "cleared" from
    /// "rejected", and collapsing them would silently accept a traversal as a
    /// clear.
    private func validatedProjectPath(_ value: String?) -> String?? {
        guard let trimmed = AutoTaskConfig.normalized(value) else { return .some(nil) }
        guard let root = manager?.projectStore?.activeProject.map({ URL(fileURLWithPath: $0.localPath) })
        else { return nil }
        guard AutoTaskPromptComposer.absolutePath(trimmed, root: root) != nil else { return nil }
        return .some(trimmed)
    }

    private func replyAutoTaskSetupDecodeFailure(type: String, data: Data?) {
        let preview = String(data: data ?? Data(), encoding: .utf8)?.prefix(100) ?? "<binary>"
        manager?.append(.stderr, "\(type) decode failed: \(preview)")
        manager?.reply(CommandError(commandId: type,
                                    message: "Invalid auto-task setup request from phone."))
    }

    /// Build and send the setup snapshot.
    ///
    /// The two catalog scans walk the project's directories, so they run off
    /// the main actor — this is reached after EVERY setup message, not just the
    /// list request, and a 400-directory enumeration on the main thread would
    /// stutter the Mac UI on each tap of the phone's picker.
    private func replyAutoTaskSetup(autoCode: AutoCodeUpdateService,
                                    templates: AutoTaskTemplateStore) {
        let root = manager?.projectStore?.activeProject.map { URL(fileURLWithPath: $0.localPath) }
        Task { [weak self] in
            let scanned = await Task.detached(priority: .userInitiated) {
                (skills: root.map { AutoTaskSkillCatalog.scan(projectRoot: $0) } ?? [],
                 folders: AutoTaskFolderCatalog.scan(projectRoot: root))
            }.value
            guard let self else { return }
            self.manager?.reply(self.buildAutoTaskSetupReply(
                autoCode: autoCode, templates: templates, root: root,
                skills: scanned.skills, folders: scanned.folders))
        }
    }

    private func buildAutoTaskSetupReply(autoCode: AutoCodeUpdateService,
                                         templates: AutoTaskTemplateStore,
                                         root: URL?,
                                         skills: [AutoTaskSkillCatalog.Entry],
                                         folders: [AutoTaskFolderCatalog.Folder]) -> AutoTaskSetupReply {
        AutoTaskSetupReply(
            hasProject: root != nil,
            projectName: manager?.projectStore?.activeProject?.bundle.displayName,
            templates: templates.templates.map {
                AutoTaskTemplateInfo(id: $0.id, name: $0.name, body: $0.body)
            },
            configs: autoCode.taskConfigs.configs.map { taskId, config in
                AutoTaskConfigInfo(taskId: taskId, inputPath: config.inputPath,
                                   outputPath: config.outputPath,
                                   skillName: config.skillName,
                                   templateId: config.templateId)
            }.sorted { $0.taskId < $1.taskId },
            skills: skills.map { AutoTaskSkillInfo(name: $0.name, description: $0.description) },
            folders: folders.map(\.path))
    }

    // MARK: - State snapshot + push helpers

    /// Build the wire snapshot the iPhone mirrors. Returns nil when the Auto
    /// Task stack isn't wired (previews / tests).
    private func buildAutoTaskState() -> AutoTaskState? {
        guard let ac = autoCode, let s = settings else { return nil }
        let allInfos = AutoTask.allCases.map { t in
            AutoTaskInfo(id: t.rawValue, label: t.label,
                         enabled: s.isEnabled(task: t),
                         lastError: ac.taskErrors[t.rawValue])
        }
        let customInfos = CustomAutoTask.loadAll().map { t in
            AutoTaskInfo(id: t.id, label: t.name, enabled: t.isEnabled,
                         lastError: ac.taskErrors[t.id])
        }
        // Mirror the Mac "Show only enabled" filter: when on, the phone sees
        // only the active task set (re-enabling a hidden task is done on Mac).
        // Custom tasks participate identically to built-ins.
        let combined = allInfos + customInfos
        let infos = s.showOnlyEnabledTasks ? combined.filter { $0.enabled } : combined
        return AutoTaskState(masterEnabled: s.enabled,
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
            manager?.reply(state)
            pushAutoTaskLogsIfPaired()
        } else {
            manager?.reply(AutoTaskAck(ok: true, message: nil))
        }
    }

    /// Build the wire snapshot of per-task live logs for the iPhone run screen.
    private func buildAutoTaskLogsReply() -> AutoTaskLogsReply? {
        guard let logStore else { return nil }
        let current = autoCode?.currentTask?.rawValue ?? autoCode?.currentCustomTaskId
        let builtIn = AutoTask.allCases.map { task in
            let lines = logStore.lines(for: task).map { line in
                AutoTaskLogLine(id: line.id.uuidString,
                                timestamp: line.timestamp.timeIntervalSince1970,
                                level: line.level.rawValue,
                                text: line.text)
            }
            return AutoTaskTaskLogs(id: task.rawValue, label: task.label, lines: lines)
        }
        let custom = CustomAutoTask.loadAll().map { task in
            let lines = logStore.lines(for: task.id).map { line in
                AutoTaskLogLine(id: line.id.uuidString,
                                timestamp: line.timestamp.timeIntervalSince1970,
                                level: line.level.rawValue,
                                text: line.text)
            }
            return AutoTaskTaskLogs(id: task.id, label: task.name, lines: lines)
        }
        return AutoTaskLogsReply(currentTask: current, tasks: builtIn + custom)
    }

    private func pushAutoTaskStateIfPaired() {
        guard manager?.mobileClientPaired == true, let state = buildAutoTaskState() else { return }
        manager?.reply(state)
    }

    /// Push the per-task settings + template snapshot after a desktop-side
    /// change, so the phone's next `AutoTaskConfigSet` (a whole-config
    /// replace) is built on current state rather than a stale one.
    private func pushAutoTaskSetupIfPaired() {
        guard manager?.mobileClientPaired == true, let autoCode,
              let templates = autoCode.autoTaskTemplates else { return }
        replyAutoTaskSetup(autoCode: autoCode, templates: templates)
    }

    private func pushAutoTaskLogsIfPaired() {
        guard manager?.mobileClientPaired == true, let logs = buildAutoTaskLogsReply() else { return }
        manager?.reply(logs)
    }
}
