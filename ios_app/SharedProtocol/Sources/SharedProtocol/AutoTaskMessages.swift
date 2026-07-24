import Foundation

// MARK: - Auto-task messages (Phase C, Task 1)

public struct AutoTaskInfo: Codable, Equatable {
    public let id: String        // AutoTask.rawValue
    public let label: String
    public let enabled: Bool
    public let lastError: String?
    public init(id: String, label: String, enabled: Bool, lastError: String?) {
        self.id = id; self.label = label; self.enabled = enabled; self.lastError = lastError
    }
}

public struct AutoTaskList: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskList
    public init() {}
}

public struct AutoTaskState: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskState
    public let masterEnabled: Bool
    public let isRunning: Bool
    public let currentTask: String?
    public let statusMessage: String?
    public let lastRunDate: Double?
    public let createdCount: Int
    public let implementedCount: Int
    public let failedCount: Int
    public let tasks: [AutoTaskInfo]

    public init(masterEnabled: Bool, isRunning: Bool, currentTask: String?, statusMessage: String?,
                lastRunDate: Double?, createdCount: Int, implementedCount: Int, failedCount: Int,
                tasks: [AutoTaskInfo]) {
        self.masterEnabled = masterEnabled
        self.isRunning = isRunning
        self.currentTask = currentTask
        self.statusMessage = statusMessage
        self.lastRunDate = lastRunDate
        self.createdCount = createdCount
        self.implementedCount = implementedCount
        self.failedCount = failedCount
        self.tasks = tasks
    }
}

public struct AutoTaskRun: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskRun
    public let task: String?
    public init(task: String?) { self.task = task }
}

public struct AutoTaskStop: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskStop
    public init() {}
}

public struct AutoTaskToggle: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskToggle
    public let task: String?      // nil = master enable
    public let enabled: Bool
    public init(task: String?, enabled: Bool) { self.task = task; self.enabled = enabled }
}

public struct AutoTaskAck: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskAck
    public let ok: Bool
    public let message: String?

    public init(ok: Bool, message: String?) {
        self.ok = ok
        self.message = message
    }
}

public struct AutoTaskHistoryList: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskHistory
    public init() {}
}

public struct AutoTaskHistoryEntry: Codable, Equatable {
    public let actionText: String
    public let status: String
    public let lastUpdated: Double
    public init(actionText: String, status: String, lastUpdated: Double) {
        self.actionText = actionText
        self.status = status
        self.lastUpdated = lastUpdated
    }
}

public struct AutoTaskHistoryReply: Codable, Equatable {
    public let type = MobileProtocol.Tag.autoTaskHistoryReply
    public let entries: [AutoTaskHistoryEntry]

    public init(entries: [AutoTaskHistoryEntry]) {
        self.entries = entries
    }
}
