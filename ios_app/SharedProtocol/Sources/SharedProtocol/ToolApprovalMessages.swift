import Foundation

// MARK: - Tool / edit permission prompts
//
// When a chat turn started from the phone needs permission to run a tool (edit a file, write one,
// run a shell command), the Mac can relay the prompt here so the turn doesn't park for 15 minutes
// waiting at the desk. The Mac only does this while "Approve or deny tool and edit requests" is ON
// in Settings → Mobile Control → Phone access (default OFF).
//
// What the phone sees is exactly what the Mac's own approval card shows — the file path, the
// before/after text or the command — redacted and capped. The answer is allow-once or deny:
// "always allow" would persist a project rule, so it stays a Mac-only decision. The answer is
// bound to a requestId the Mac issued and re-validated against the engine's live pending prompt.

public struct ToolApprovalRequest: Codable, Equatable, Identifiable {
    public let type = MobileProtocol.Tag.toolApprovalRequest
    public let commandId: String
    public let requestId: String
    /// The tool's name, e.g. "Edit", "Write", "Bash".
    public let toolName: String
    /// A short one-line description.
    public let summary: String?
    /// Home-relative path for file tools.
    public let filePath: String?
    public let oldString: String?
    public let newString: String?
    public let contentPreview: String?
    public let command: String?
    /// True when any field was cut (by the server's cap or the Mac's).
    public let truncated: Bool
    public let replaceAll: Bool?
    /// Write only: the target already exists, so this overwrites it.
    public let overwrites: Bool?
    public var id: String { requestId }

    public init(commandId: String, requestId: String, toolName: String, summary: String?,
                filePath: String?, oldString: String?, newString: String?, contentPreview: String?,
                command: String?, truncated: Bool, replaceAll: Bool?, overwrites: Bool?) {
        self.commandId = commandId
        self.requestId = requestId
        self.toolName = toolName
        self.summary = summary
        self.filePath = filePath
        self.oldString = oldString
        self.newString = newString
        self.contentPreview = contentPreview
        self.command = command
        self.truncated = truncated
        self.replaceAll = replaceAll
        self.overwrites = overwrites
    }
    private enum CodingKeys: String, CodingKey {
        case type, commandId, requestId, toolName, summary, filePath, oldString, newString
        case contentPreview, command, truncated, replaceAll, overwrites
    }
}

public struct ToolApprovalAnswer: Codable, Equatable {
    public let type = MobileProtocol.Tag.toolApprovalAnswer
    public let commandId: String
    public let requestId: String
    /// Allow this one call, or deny it. There is deliberately no "always allow".
    public let allow: Bool
    public init(commandId: String, requestId: String, allow: Bool) {
        self.commandId = commandId
        self.requestId = requestId
        self.allow = allow
    }
    private enum CodingKeys: String, CodingKey { case type, commandId, requestId, allow }
}
