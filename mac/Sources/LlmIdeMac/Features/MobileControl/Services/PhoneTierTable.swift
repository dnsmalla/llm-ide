import Foundation
import SharedProtocol

/// How much authority an inbound phone message carries, from the command-bus spec (section 1.4).
///
/// The tier belongs to the MESSAGE TYPE and is the highest any use of that type can reach. A bridge may
/// still be stricter for a particular payload (`selfheal_action` ignore is bookkeeping, apply is T2).
enum PhoneTier: String {
    /// Reads Mac state. No side effect beyond the reply.
    case read = "R"
    /// A low-risk, reversible command (chat turn, cancel, rename, switch project).
    case command = "C"
    /// Starts read-only work with no desktop approval.
    case taskReadOnly = "T0"
    /// Changes files or data, or acts as the user: behind a Phone access switch and/or a desktop approval.
    case approval = "T1"
    /// Writes code or leaves the machine: needs the person at the Mac to confirm the exact action.
    case approvalConfirm = "T2"
    /// Desktop only: the phone may never do this, whatever any switch says.
    case desktopOnly = "D"
    /// Pairing / heartbeat, consumed by the socket layer before dispatch.
    case link = "link"
    /// Mac to phone only. A phone sending one is refused.
    case macToPhone = "out"
}

/// THE table: every wire message type and its tier, consulted in ONE place (`MobileControlManager.handleInbound`)
/// before any bridge sees a frame. Unknown types fail closed. Each bridge keeps its own switch and payload
/// checks as defence in depth, so removing a bridge check never widens what a phone can do.
///
/// Adding a wire tag without a row here fails `PhoneTierTableTests` (which iterates `MobileProtocol.Tag.all`).
enum PhoneTierTable {
    typealias Tag = MobileProtocol.Tag

    static let tiers: [String: PhoneTier] = [
        // Link
        Tag.pairing: .link, Tag.heartbeat: .link,
        // Chat
        Tag.llmIdeChat: .command,
        Tag.llmIdeCancel: .command,
        Tag.approvalAnswer: .command,                 // answers the agent's own question (labels only)
        Tag.toolApprovalAnswer: .approval,            // remote tool approval, behind the toolApprovals switch
        Tag.llmIdeChatHistoryList: .read,
        // Destructive, but gated today by its own switch (chat deletion). Spec target is D; kept T1 until
        // the deletion switch is retired so an enabled setting keeps working.
        Tag.llmIdeChatHistoryClear: .approval,
        Tag.macStatusList: .read,
        // Explorer chat
        Tag.exploreListSessions: .read, Tag.exploreLoadSession: .read,
        Tag.exploreNewSession: .command, Tag.exploreRenameSession: .command, Tag.exploreCancel: .command,
        Tag.exploreChat: .command,                    // never inherits the Mac's Auto/Bypass chip
        Tag.exploreDeleteSession: .approval,          // see llmIdeChatHistoryClear
        Tag.exploreSearchFiles: .read, Tag.exploreSearchSkills: .read,
        // Auto Tasks
        Tag.autoTaskList: .read, Tag.autoTaskHistory: .read, Tag.autoTaskLogsList: .read,
        Tag.autoTaskSetupList: .read,
        Tag.autoTaskStop: .command,
        Tag.autoTaskRun: .approvalConfirm,            // implement / review-merge confirm on the Mac
        Tag.autoTaskToggle: .desktopOnly,
        Tag.autoTaskConfigSet: .desktopOnly,
        Tag.autoTaskTemplateSave: .desktopOnly,
        Tag.autoTaskTemplateRename: .desktopOnly,
        Tag.autoTaskTemplateDelete: .desktopOnly,
        // Loop
        Tag.loopStatusList: .read, Tag.loopHistory: .read, Tag.loopStop: .command,
        Tag.loopStart: .approval, Tag.loopStartStage: .approval,
        // Doc Gen / llm-doc
        Tag.generationOptionsList: .read, Tag.llmDocList: .read, Tag.llmDocRead: .read,
        Tag.generationRun: .approval,
        // Files, issues, source control (read-only)
        Tag.filesList: .read, Tag.filesRead: .read,
        Tag.issuesList: .read, Tag.issueGet: .read, Tag.issueCommentPost: .approval,
        Tag.scmStatusList: .read, Tag.scmDiff: .read,
        // Self-Heal
        Tag.selfHealList: .read, Tag.selfHealDiff: .read,
        Tag.selfHealAction: .approvalConfirm,         // apply / discard confirm on the Mac
        // Projects, usage, activity
        Tag.projectList: .read, Tag.projectSwitch: .command,
        Tag.usageGet: .read, Tag.activityList: .read, Tag.activityMarkSeen: .read,
        // Mac -> phone only
        Tag.connected: .macToPhone, Tag.authFailed: .macToPhone, Tag.disconnected: .macToPhone,
        Tag.heartbeatAck: .macToPhone, Tag.output: .macToPhone, Tag.error: .macToPhone,
        Tag.approvalRequest: .macToPhone, Tag.approvalCleared: .macToPhone,
        Tag.exploreSessionList: .macToPhone, Tag.exploreSessionHistory: .macToPhone,
        Tag.exploreSessionCreated: .macToPhone, Tag.exploreSearchReply: .macToPhone,
        Tag.exploreSkillListReply: .macToPhone, Tag.exploreSessionRenamed: .macToPhone,
        Tag.llmIdeChatHistoryReply: .macToPhone, Tag.llmIdeChatHistoryClearAck: .macToPhone,
        Tag.macStatus: .macToPhone,
        Tag.autoTaskState: .macToPhone, Tag.autoTaskAck: .macToPhone,
        Tag.autoTaskHistoryReply: .macToPhone, Tag.autoTaskLogsReply: .macToPhone,
        Tag.autoTaskSetupReply: .macToPhone,
        Tag.loopState: .macToPhone, Tag.loopAck: .macToPhone, Tag.loopHistoryReply: .macToPhone,
        Tag.generationOptions: .macToPhone, Tag.generationResult: .macToPhone,
        Tag.llmDocListing: .macToPhone, Tag.llmDocFile: .macToPhone,
        Tag.macCapabilities: .macToPhone,
        Tag.filesListing: .macToPhone, Tag.filesFile: .macToPhone,
        Tag.issuesState: .macToPhone, Tag.issueDetail: .macToPhone,
        Tag.scmState: .macToPhone, Tag.scmDiffResult: .macToPhone,
        Tag.toolApprovalRequest: .macToPhone,
        Tag.selfHealState: .macToPhone, Tag.selfHealDiffResult: .macToPhone,
        Tag.projectState: .macToPhone, Tag.usageState: .macToPhone, Tag.activityState: .macToPhone,
    ]

    enum Verdict: Equatable {
        case allow(PhoneTier)
        case refuse(code: String, message: String)
    }

    /// The single decision for an inbound frame's `type`.
    static func verdict(for type: String) -> Verdict {
        guard let tier = tiers[type] else {
            return .refuse(code: MobileRefusalCode.unknownType,
                           message: "Your Mac doesn't know this request. Update LLM-IDE or the phone app.")
        }
        switch tier {
        case .desktopOnly:
            return .refuse(code: MobileRefusalCode.desktopOnly, message: "This is only available on your Mac.")
        case .macToPhone:
            return .refuse(code: MobileRefusalCode.tierRefused, message: "A phone cannot send this message.")
        case .read, .command, .taskReadOnly, .approval, .approvalConfirm, .link:
            return .allow(tier)
        }
    }
}
