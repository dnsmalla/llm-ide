import Foundation

// MARK: - Tool / edit permission prompts
//
// When a chat turn started from the phone needs permission to run a tool (edit a file, write one, run a
// shell command), the host relays the prompt (Host API v1 `toolApproval.request`, capability
// `tool_approvals`) so the turn doesn't park waiting at the desk. The phone sees the file path, the
// before/after text or the command, redacted and capped, and answers allow-once or deny
// (`toolApprovals.answer`): "always allow" would persist a project rule, so it stays a desktop decision.

public struct ToolApprovalRequest: Codable, Equatable, Identifiable {
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
}

public extension ToolApprovalRequest {
    /// The Host API v1 `toolApproval.request` payload, as the tool card renders it.
    init(event e: HostApiToolApprovalRequestEvent) {
        self.init(commandId: e.commandId, requestId: e.requestId, toolName: e.toolName, summary: e.summary,
                  filePath: e.filePath, oldString: e.oldString, newString: e.newString,
                  contentPreview: e.contentPreview, command: e.command, truncated: e.truncated,
                  replaceAll: e.replaceAll, overwrites: e.overwrites)
    }
}
