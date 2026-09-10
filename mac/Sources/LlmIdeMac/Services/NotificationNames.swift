import Foundation

/// Single source of truth for app-wide Notification names.
///
/// Why one file: scattered Notification.Name extensions made it easy
/// to accidentally collide on raw string keys, miss listeners, or
/// drift documentation. New names belong here — DON'T re-open this
/// extension elsewhere.
///
/// Grouped by domain. Each entry documents who posts and who observes
/// so the wire-up is greppable without chasing call sites.
extension Notification.Name {

    // MARK: - Shell / navigation

    /// Posted by anywhere that wants to slide the user into the
    /// Settings tab — e.g. the menu-bar "Settings…" item.
    static let openSettings = Notification.Name("openSettings")

    /// Switch the main window to a specific section. Post with the
    /// target `ShellState.Section.rawValue` as `object`. Posted by
    /// MenuBarHubView rows so a click from the menu bar lands the user
    /// inside the right tab, and by the chat composer's "/" commands
    /// and hook/MCP menu rows — the latter may add a
    /// `userInfo["libraryTarget"]: ShellState.LibrarySelection` to
    /// pre-select the exact Library row being navigated to.
    static let openSection = Notification.Name("openSection")

    /// Posted by Library detail views when the user clicks
    /// "Configure in Settings". The `object` is a string id matching
    /// a SettingsView anchor ("plugins" today). SettingsView observes
    /// and scrolls its ScrollView to that anchor on next render.
    static let scrollSettingsToCard = Notification.Name("scrollSettingsToCard")

    // MARK: - LLM Chat (Mac sheet + iPhone llmide_chat)

    /// Open the global llm-chat sheet. Posted by the status-bar chip and
    /// ⌘⇧L. Observed by AppShell.
    static let openLlmChatSheet = Notification.Name("openLlmChatSheet")

    // `llmChatTranscriptChanged` lived here until the quick chat was
    // unified. It announced a write to the `/kb/agent/ask` transcript table
    // so the Mac chat surfaces could re-fetch it; all three surfaces now
    // share one `.quick` `ChatEngine` that owns its transcript directly, so
    // the last observer went away and the two remaining posts told nobody.
    // Removed rather than kept as an "external hook" — nothing outside this
    // process can observe an in-process NotificationCenter name.

    /// Posted when a custom Auto Task's enabled-state changes via a
    /// phone-originated toggle — AutoCodeView observes this to reload its
    /// local `customTasks` snapshot, since CustomAutoTask is a plain struct
    /// with no shared ObservableObject the Mac UI already listens to.
    static let customAutoTasksChanged = Notification.Name("customAutoTasksChanged")

    /// Posted by `CustomProvider.saveAll` after the persisted custom-provider
    /// list changes (add / edit / delete / enable toggle in Settings →
    /// Custom Providers). CodeAssistantPanel observes it to reload its
    /// `modelState.customProviders` snapshot, which otherwise only loaded on
    /// appear — so an Anthropic-compatible URL added while a chat is open
    /// updates the composer's provider menu and Agent-engine hint at once,
    /// keeping them in step with the transport, which reads the live list
    /// every turn.
    static let customProvidersChanged = Notification.Name("customProvidersChanged")

    // MARK: - Library / meetings

    /// Posted by LibraryRow when the user requests an action on a
    /// meeting row's context menu. (Re-summarize now flows through
    /// ShellState.pendingResummarizeMeetingId instead of a notification.)
    static let exportMeeting         = Notification.Name("exportMeeting")
    static let revealMeetingInFinder = Notification.Name("revealMeetingInFinder")
    /// Posted by LibraryRow "Delete" context-menu item. `object` is the
    /// meeting row id (String). LibraryView observes and deletes the .md file
    /// + removes the index entry.
    static let deleteMeeting         = Notification.Name("deleteMeeting")
    /// Posted by the Meetings file-tree context menu to re-summarize a
    /// transcript .md file. `object` is the file URL. AppShell observes
    /// and triggers the summarise → .docx pipeline directly.
    static let resummarizeMeetingFile = Notification.Name("resummarizeMeetingFile")

    /// Posted by LiveSessionMirror when it detects that the Chrome
    /// extension has finalized a live session.  The `object` is a
    /// `LiveSessionMirror.FinalizedPayload` value — AppShell observes
    /// this to generate a note file automatically without the user
    /// having to click "Generate Notes" in the side panel.
    static let liveSessionFinalized = Notification.Name("liveSessionFinalized")

    /// Posted by FolderIndexer when the underlying meeting index
    /// changes — Library + Plan + Doc Gen all refresh on this.
    static let meetingIndexChanged = Notification.Name("MeetingIndexChanged")

    /// Posted when the user picks a new notes folder. AppShell tears
    /// down and re-creates AppEnvironment so the indexer + index DB
    /// point at the new path.
    static let notesFolderChanged = Notification.Name("NotesFolderChanged")

    /// Posted by AppShell when ⌘F is pressed; LibraryView focuses its
    /// filter field.
    static let focusLibraryFilter = Notification.Name("FocusLibraryFilter")

    // MARK: - Projects

    /// Posted by ProjectStore when the active project changes (open,
    /// close, switch). Observers: code-assist context refresh, code
    /// graph rebuilds, etc.
    static let activeProjectChanged = Notification.Name("activeProjectChanged")

    // MARK: - Chat approvals

    /// Posted by AppShell's pending-approval toolbar button (see
    /// `ChatEngineRegistry.pendingApprovals`) right after it swaps the
    /// target session into `ChatEngineRegistry.displayed` and sets
    /// `shell.section`. `object` is a `PendingApprovalReveal`.
    ///
    /// That registry swap alone is enough for a panel that mounts AFTER
    /// this posts (a section the user wasn't already looking at) — its
    /// `init` reads the now-updated `ChatEngineRegistry.engine(for:)`. It is
    /// NOT enough for a panel that is already mounted and showing a
    /// DIFFERENT session in the same scope: its `@State` engine reference
    /// was captured at mount and nothing else tells it to re-fetch. Every
    /// `CodeAssistantPanel` observes this and, when the scope matches its
    /// own, calls its own `switchToSession(_:)` — the same path its session
    /// picker uses, which re-points `@State` at whatever the registry now
    /// holds and re-wires hooks onto it.
    static let revealPendingApprovalSession = Notification.Name("revealPendingApprovalSession")
}

/// Payload for `.revealPendingApprovalSession`.
struct PendingApprovalReveal {
    let scope: ChatScope
    let sessionID: UUID
}
