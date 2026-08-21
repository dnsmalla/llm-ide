import Foundation

/// Wire-protocol constants shared by the macOS server and the iOS client.
public enum MobileProtocol {
    /// Bonjour service type advertised by the Mac app (no trailing dot).
    /// `NSBonjourServices` uses this form; `NetServiceBrowser` appends a dot.
    public static let serviceType = "_llmide._tcp"

    /// Default TCP port the Mac app listens on.
    public static let defaultPort = 3006

    /// Heartbeat cadence (seconds).
    public static let heartbeatInterval: TimeInterval = 10

    /// Drop the connection if no heartbeat is received within this window.
    public static let heartbeatTimeout: TimeInterval = 25

    /// Single source of truth for every message `type` discriminator on the
    /// wire. Structs reference these constants from their `let type = …` so the
    /// tag string lives in exactly one place. The on-the-wire value is the raw
    /// string literal (e.g. `Tag.heartbeat == "heartbeat"`), so the JSON is
    /// byte-identical to the previous inline literals.
    public enum Tag {
        // MARK: Connection lifecycle
        public static let pairing = "pairing"
        public static let heartbeat = "heartbeat"
        public static let heartbeatAck = "heartbeat_ack"
        public static let connected = "connected"
        public static let authFailed = "auth_failed"

        // MARK: llm-ide chat channel
        public static let llmIdeChat = "llmide_chat"
        public static let output = "output"
        public static let error = "error"

        // MARK: Explorer-chat sessions
        public static let exploreListSessions = "explore_list_sessions"
        public static let exploreSessionList = "explore_session_list"
        public static let exploreLoadSession = "explore_load_session"
        public static let exploreSessionHistory = "explore_session_history"
        public static let exploreNewSession = "explore_new_session"
        public static let exploreSessionCreated = "explore_session_created"
        public static let exploreDeleteSession = "explore_delete_session"
        public static let exploreChat = "explore_chat"
        public static let exploreSearchFiles = "explore_search_files"
        public static let exploreSearchReply = "explore_search_reply"
        public static let exploreSearchSkills = "explore_search_skills"
        public static let exploreSkillListReply = "explore_skill_list_reply"
        public static let exploreCancel = "explore_cancel"
        public static let exploreRenameSession = "explore_rename_session"
        public static let exploreSessionRenamed = "explore_session_renamed"

        // MARK: llm-ide chat control
        public static let llmIdeCancel = "llmide_cancel"
        public static let llmIdeChatHistoryList = "llmide_chat_history_list"
        public static let llmIdeChatHistoryReply = "llmide_chat_history_reply"
        public static let llmIdeChatHistoryClear = "llmide_chat_history_clear"
        public static let llmIdeChatHistoryClearAck = "llmide_chat_history_clear_ack"

        // MARK: Mac status snapshot
        public static let macStatusList = "mac_status_list"
        public static let macStatus = "mac_status"

        // MARK: Auto-task channel
        public static let autoTaskList = "auto_task_list"
        public static let autoTaskState = "auto_task_state"
        public static let autoTaskRun = "auto_task_run"
        public static let autoTaskStop = "auto_task_stop"
        public static let autoTaskToggle = "auto_task_toggle"
        public static let autoTaskAck = "auto_task_ack"
        public static let autoTaskHistory = "auto_task_history"
        public static let autoTaskHistoryReply = "auto_task_history_reply"
        public static let autoTaskLogsList = "auto_task_logs_list"
        public static let autoTaskLogsReply = "auto_task_logs_reply"

        // MARK: Loop channel — remote control only; see LoopMessages.swift
        public static let loopStatusList = "loop_status_list"
        public static let loopState = "loop_state"
        public static let loopStart = "loop_start"
        public static let loopStartStage = "loop_start_stage"
        public static let loopStop = "loop_stop"
        public static let loopAck = "loop_ack"
        public static let loopHistory = "loop_history"
        public static let loopHistoryReply = "loop_history_reply"
    }
}
