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
    /// MenuBarMenu rows so a click from the menu bar lands the user
    /// inside the right tab.
    static let openSection = Notification.Name("openSection")

    /// Posted by Library detail views when the user clicks
    /// "Configure in Settings". The `object` is a string id matching
    /// a SettingsView anchor ("plugins" today). SettingsView observes
    /// and scrolls its ScrollView to that anchor on next render.
    static let scrollSettingsToCard = Notification.Name("scrollSettingsToCard")

    // MARK: - Agent

    /// Open the global "Ask the agent" sheet. Posted by Cmd-Shift-A
    /// and by the chat button inside the badge popover. Observed by
    /// AppShell, which owns the sheet so it survives section changes.
    static let openAskAgentSheet = Notification.Name("openAskAgentSheet")

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
}
