import Foundation

/// Sheet/popover presentation flags for `CodeAssistantPanel` — pure UI
/// plumbing with no invariant coupling (unlike the composer/session/
/// streaming state, which must stay untouched; see
/// docs/explanation/invariants.md's "macOS Code Assistant panel" section).
/// Each flag pairs 1:1 with a `.sheet(isPresented:)` call in
/// `CodeAssistantPanel.swift`.
///
/// `planEditTarget` is the exception on both counts: it drives a
/// `.sheet(item:)` and it is NOT inert — it names a message in the live
/// transcript and its Save writes a file, so the panel must clear it whenever
/// the transcript or the open project changes underneath it (see
/// `adoptEngine` and `handleActiveRepoChange`).
@Observable
final class CodeAssistantSheetState {
    var showingIssueSheet = false
    var showingCommentSheet = false
    var showingGetIssueSheet = false
    var showingUpdateIssueSheet = false
    var showingListIssuesSheet = false
    var showingCreateBranchSheet = false
    var branchSheetContext: AgentContext?
    var showingCreatePRSheet = false
    var showingReviewCodeSheet = false
    var showingUpdateFileSheet = false
    var showingGitOpSheet = false
    var showLibraryPicker = false
    var showProjectMemory = false
    /// The plan the chat's "Edit" action opened for hand-editing, or nil when
    /// the sheet is closed. Driven by `.sheet(item:)` rather than a Bool flag
    /// so the presented draft and its target message can never disagree.
    var planEditTarget: PlanEditTarget?
}
