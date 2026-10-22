import Foundation

/// An inbound `auto_task_*` phone request, decoded by `MobileBridgeHosting`.
///
/// Foundation-only on purpose: `MobileAutoTaskBridge` (Features/AutoTask)
/// compiles whenever `auto_tasks` does, but `SharedProtocol` is linked only
/// with `mobile_sync`. Each case mirrors one wire message; a NIL payload means
/// the frame named that type but did not decode — the bridge still runs its
/// access / wiring checks first and only then reports the bad payload, the
/// order the phone has always seen.
enum MobileAutoTaskRequest: Equatable {
    case list
    case toggle(Toggle?)
    case run(Run?)
    case stop
    case history
    case logsList
    case setupList
    case configSet(ConfigSet?)
    case templateSave(TemplateSave?)
    case templateRename(TemplateRename?)
    case templateDelete(TemplateDelete?)

    /// `task == nil` flips the master enable.
    struct Toggle: Equatable {
        let task: String?
        let enabled: Bool
    }

    /// `task == nil` runs every enabled task.
    struct Run: Equatable {
        let task: String?
    }

    /// Replaces one task's whole per-task config.
    struct ConfigSet: Equatable {
        let taskId: String
        let inputPath: String?
        let outputPath: String?
        let skillName: String?
        let templateId: String?
    }

    /// `id == nil` creates a new template.
    struct TemplateSave: Equatable {
        let id: String?
        let name: String
        let body: String
    }

    struct TemplateRename: Equatable {
        let id: String
        let name: String
    }

    struct TemplateDelete: Equatable {
        let id: String
    }
}

/// An outbound Auto Task reply, encoded into its wire type by
/// `MobileBridgeHosting.sendAutoTaskReply`. Field-for-field mirrors of the
/// `SharedProtocol` messages, for the same reason as `MobileAutoTaskRequest`.
enum MobileAutoTaskReply: Equatable {
    case state(State)
    case ack(ok: Bool, message: String?)
    case history([HistoryEntry])
    case logs(Logs)
    case setup(Setup)

    /// Scheduler + per-task snapshot (wire: `AutoTaskState`).
    struct State: Equatable {
        let masterEnabled: Bool
        let isRunning: Bool
        let currentTask: String?
        let currentStep: String?
        let statusMessage: String?
        /// Seconds since 1970.
        let lastRunDate: Double?
        let createdCount: Int
        let implementedCount: Int
        let failedCount: Int
        let tasks: [TaskInfo]
    }

    /// One task row (wire: `AutoTaskInfo`).
    struct TaskInfo: Equatable {
        let id: String
        let label: String
        let enabled: Bool
        let lastError: String?
    }

    /// One processed-action row (wire: `AutoTaskHistoryEntry`).
    struct HistoryEntry: Equatable {
        let actionText: String
        let status: String
        /// Seconds since 1970.
        let lastUpdated: Double
    }

    /// Per-task live logs (wire: `AutoTaskLogsReply`).
    struct Logs: Equatable {
        let currentTask: String?
        let tasks: [TaskLogs]
    }

    /// One task's log buffer (wire: `AutoTaskTaskLogs`).
    struct TaskLogs: Equatable {
        let id: String
        let label: String
        let lines: [LogLine]
    }

    /// One log line (wire: `AutoTaskLogLine`).
    struct LogLine: Equatable {
        let id: String
        /// Seconds since 1970.
        let timestamp: Double
        let level: String
        let text: String
    }

    /// Per-task settings + template library (wire: `AutoTaskSetupReply`).
    struct Setup: Equatable {
        let hasProject: Bool
        let projectName: String?
        let templates: [Template]
        let configs: [TaskConfig]
        let skills: [Skill]
        let folders: [String]
    }

    /// Wire: `AutoTaskTemplateInfo`.
    struct Template: Equatable {
        let id: String
        let name: String
        let body: String
    }

    /// Wire: `AutoTaskConfigInfo`.
    struct TaskConfig: Equatable {
        let taskId: String
        let inputPath: String?
        let outputPath: String?
        let skillName: String?
        let templateId: String?
    }

    /// Wire: `AutoTaskSkillInfo`.
    struct Skill: Equatable {
        let name: String
        let description: String
    }
}
