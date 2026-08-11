import Foundation

/// Sheet/popover presentation flags for `CodeAssistantPanel` — pure UI
/// plumbing with no invariant coupling (unlike the composer/session/
/// streaming state, which must stay untouched; see
/// docs/explanation/invariants.md's "macOS Code Assistant panel" section).
/// Each flag pairs 1:1 with a `.sheet(isPresented:)` call in
/// `CodeAssistantPanel.swift`.
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
    var reportingFault: CodeAssistantPanel.FaultReportContext?
}
