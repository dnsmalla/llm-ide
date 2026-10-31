import Foundation
import SharedProtocol

/// The manager's side of the Auto Task / Loop phone seam.
///
/// `MobileAutoTaskBridge` (Features/AutoTask) and `MobileLoopBridge`
/// (Features/Loop) talk to the manager only through `MobileBridgeHosting`, and
/// never import `SharedProtocol` — they must compile in a build with
/// `auto_tasks` on and `mobile_sync` off, where that package is not linked.
/// So every wire concern lives here: the tag → request decode on the way in
/// and the reply → wire-type encode on the way out. The mapping is
/// field-for-field and type-checked against `SharedProtocol`, so a wire change
/// fails to compile here rather than drifting from the Core mirrors.
///
/// `config`, `projectStore`, `mobileClientPaired` and `replyNotConfigured`
/// satisfy their requirements as declared on the manager.
extension MobileControlManager: MobileBridgeHosting {
    func isPhoneAccessAllowed(_ access: MobileBridgeAccess) -> Bool {
        phoneAccess.isAllowed(Self.phoneAccess(for: access))
    }

    func phoneAccessDeniedMessage(_ access: MobileBridgeAccess) -> String {
        Self.phoneAccess(for: access).deniedMessage
    }

    var phoneTextRedactor: @Sendable (String) -> String {
        { PhoneRedaction.logLine($0) }
    }

    func logInfo(_ text: String) {
        append(.info, text)
    }

    func logError(_ text: String) {
        append(.stderr, text)
    }

    func logDecodeFailure(type: String, data: Data?) {
        append(.stderr, "\(MobileLogPolicy.typeLabel(type)) decode failed (\(MobileLogPolicy.frameLabel(data)))")
    }

    func replyCommandError(commandId: String, message: String, code: String?) {
        reply(CommandError(commandId: commandId, message: message, code: code))
    }

    /// Exhaustive so a new `MobileBridgeAccess` case cannot compile without
    /// naming the switch it maps to.
    private static func phoneAccess(for access: MobileBridgeAccess) -> PhoneAccess {
        switch access {
        case .autoTaskControl: return .autoTaskControl
        case .loopControl:     return .loopControl
        }
    }

    // MARK: - Auto Tasks

    func decodeAutoTaskRequest(type: String, data: Data?) -> MobileAutoTaskRequest? {
        let bytes = data ?? Data()
        switch type {
        case MobileProtocol.Tag.autoTaskList:
            return .list
        case MobileProtocol.Tag.autoTaskToggle:
            return .toggle(decodeOrNil(AutoTaskToggle.self, bytes).map {
                .init(task: $0.task, enabled: $0.enabled)
            })
        case MobileProtocol.Tag.autoTaskRun:
            return .run(decodeOrNil(AutoTaskRun.self, bytes).map { .init(task: $0.task) })
        case MobileProtocol.Tag.autoTaskStop:
            return .stop
        case MobileProtocol.Tag.autoTaskHistory:
            return .history
        case MobileProtocol.Tag.autoTaskLogsList:
            return .logsList
        case MobileProtocol.Tag.autoTaskSetupList:
            return .setupList
        case MobileProtocol.Tag.autoTaskConfigSet:
            return .configSet(decodeOrNil(AutoTaskConfigSet.self, bytes).map {
                .init(taskId: $0.taskId, inputPath: $0.inputPath, outputPath: $0.outputPath,
                      skillName: $0.skillName, templateId: $0.templateId)
            })
        case MobileProtocol.Tag.autoTaskTemplateSave:
            return .templateSave(decodeOrNil(AutoTaskTemplateSave.self, bytes).map {
                .init(id: $0.id, name: $0.name, body: $0.body)
            })
        case MobileProtocol.Tag.autoTaskTemplateRename:
            return .templateRename(decodeOrNil(AutoTaskTemplateRename.self, bytes).map {
                .init(id: $0.id, name: $0.name)
            })
        case MobileProtocol.Tag.autoTaskTemplateDelete:
            return .templateDelete(decodeOrNil(AutoTaskTemplateDelete.self, bytes).map { .init(id: $0.id) })
        default:
            return nil
        }
    }

    func sendAutoTaskReply(_ reply: MobileAutoTaskReply) {
        switch reply {
        case .state(let state):
            self.reply(Self.wire(state))
        case .ack(let ok, let message, let code):
            self.reply(AutoTaskAck(ok: ok, message: message, code: code))
        case .history(let entries):
            self.reply(AutoTaskHistoryReply(entries: entries.map {
                AutoTaskHistoryEntry(actionText: $0.actionText, status: $0.status,
                                     lastUpdated: $0.lastUpdated)
            }))
        case .logs(let logs):
            self.reply(AutoTaskLogsReply(currentTask: logs.currentTask, tasks: logs.tasks.map { task in
                AutoTaskTaskLogs(id: task.id, label: task.label, lines: task.lines.map {
                    AutoTaskLogLine(id: $0.id, timestamp: $0.timestamp, level: $0.level, text: $0.text)
                })
            }))
        case .setup(let setup):
            self.reply(Self.wire(setup))
        }
    }

    private static func wire(_ state: MobileAutoTaskReply.State) -> AutoTaskState {
        AutoTaskState(masterEnabled: state.masterEnabled,
                      isRunning: state.isRunning,
                      currentTask: state.currentTask,
                      currentStep: state.currentStep,
                      statusMessage: state.statusMessage,
                      lastRunDate: state.lastRunDate,
                      createdCount: state.createdCount,
                      implementedCount: state.implementedCount,
                      failedCount: state.failedCount,
                      tasks: state.tasks.map {
                          AutoTaskInfo(id: $0.id, label: $0.label, enabled: $0.enabled,
                                       lastError: $0.lastError)
                      })
    }

    private static func wire(_ setup: MobileAutoTaskReply.Setup) -> AutoTaskSetupReply {
        AutoTaskSetupReply(
            hasProject: setup.hasProject,
            projectName: setup.projectName,
            templates: setup.templates.map { AutoTaskTemplateInfo(id: $0.id, name: $0.name, body: $0.body) },
            configs: setup.configs.map {
                AutoTaskConfigInfo(taskId: $0.taskId, inputPath: $0.inputPath,
                                   outputPath: $0.outputPath, skillName: $0.skillName,
                                   templateId: $0.templateId)
            },
            skills: setup.skills.map { AutoTaskSkillInfo(name: $0.name, description: $0.description) },
            folders: setup.folders)
    }

    // MARK: - Loop

    func decodeLoopRequest(type: String, data: Data?) -> MobileLoopRequest? {
        let bytes = data ?? Data()
        switch type {
        case MobileProtocol.Tag.loopStatusList:
            return .status
        case MobileProtocol.Tag.loopStart:
            return .start
        case MobileProtocol.Tag.loopStartStage:
            return .startStage(stageId: decodeOrNil(LoopStartStage.self, bytes)?.stageId)
        case MobileProtocol.Tag.loopStop:
            return .stop
        case MobileProtocol.Tag.loopHistory:
            return .history(limit: decodeOrNil(LoopHistoryRequest.self, bytes)?.limit)
        default:
            return nil
        }
    }

    func sendLoopReply(_ reply: MobileLoopReply) {
        switch reply {
        case .state(let state):
            self.reply(LoopState(
                configured: state.configured,
                projectName: state.projectName,
                running: state.running,
                startedHere: state.startedHere,
                iteration: state.iteration,
                maxIterations: state.maxIterations,
                logTail: state.logTail,
                lastStatusSummary: state.lastStatusSummary,
                lastFinishedAt: state.lastFinishedAt,
                stages: state.stages.map {
                    LoopStageInfo(name: $0.name, kind: $0.kind, severity: $0.severity,
                                  enabled: $0.enabled, order: $0.order, stageId: $0.stageId)
                },
                queuedCount: state.queuedCount))
        case .ack(let accepted, let message):
            self.reply(LoopAck(accepted: accepted, message: message))
        case .history(let runs):
            self.reply(LoopHistoryReply(runs: runs.map {
                LoopRunSummary(id: $0.id, startedAt: $0.startedAt,
                               durationSeconds: $0.durationSeconds,
                               iterationsUsed: $0.iterationsUsed,
                               statusCode: $0.statusCode,
                               statusSummary: $0.statusSummary,
                               trigger: $0.trigger)
            }))
        }
    }

    /// `try?` in one place: a payload that fails to decode becomes a nil
    /// request payload, which the bridge reports after its own checks.
    private func decodeOrNil<T: Decodable>(_ type: T.Type, _ bytes: Data) -> T? {
        try? decoder.decode(type, from: bytes)
    }
}
