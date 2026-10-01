import Foundation
import SharedProtocol

/// Shapes a parked tool/edit permission prompt for the phone: the same content the Mac's own
/// approval card shows, but redacted, capped, and with absolute paths made home-relative.
enum MobileToolApproval {
    static let maxField = 4_000
    static let maxSummary = 300

    nonisolated static func request(from approval: AgentV2Approval, commandId: String) -> ToolApprovalRequest {
        let args = approval.args
        var cut = args?.truncated ?? false
        func field(_ text: String?) -> String? {
            guard let text, !text.isEmpty else { return nil }
            let r = PhoneRedaction.lines(text, maxChars: maxField)
            if r.truncated { cut = true }
            return r.text
        }
        return ToolApprovalRequest(
            commandId: commandId,
            requestId: approval.requestId,
            toolName: String((approval.toolName ?? "Tool").prefix(60)),
            summary: approval.argsSummary.map { PhoneRedaction.short($0, limit: maxSummary) },
            filePath: args?.filePath.map { PhoneRedaction.short(PathUtils.homeRelative($0), limit: 300) },
            oldString: field(args?.oldString),
            newString: field(args?.newString),
            contentPreview: field(args?.contentPreview),
            command: field(args?.command),
            truncated: cut,
            replaceAll: args?.replaceAll,
            overwrites: args?.exists)
    }
}
