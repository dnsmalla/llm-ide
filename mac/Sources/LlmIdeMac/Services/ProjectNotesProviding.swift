import Foundation

/// One project-rooted note file (`<project>/llm-doc/...`) — the output of a
/// source connector (email, Slack, …) once generated, as opposed to a raw
/// meeting transcript (which lives under the separate global meetings folder
/// and is covered by `MeetingIndex` instead — see `runSourcesToIssue`).
struct ProjectNoteRef: Equatable {
    let id: String
    let title: String
    let fileURL: URL
    /// Best-known "generated at" time for lookback filtering — the note's
    /// `yyyy-MM-dd-HHmmss` filename prefix when parseable (every writer
    /// stamps one), falling back to on-disk mtime only when it isn't.
    /// Deliberately NOT plain file mtime: `llm-doc/` is project-rooted
    /// content, so a fresh clone, `git checkout`, or folder copy stamps
    /// every note with "now" — which would put the project's entire note
    /// history inside every lookback window and file an issue per action
    /// item on first run.
    let modifiedAt: Date
}

/// Narrow seam AutoTask depends on instead of the concrete `LibraryItemStore`
/// (which also owns Code/Data/unrelated Library UI concerns). Keeps
/// `runSourcesToIssue` from silently breaking whenever LibraryItemStore's
/// scan internals change — it only needs "give me the project's notes."
///
/// Lives in `Services/` (not `AutoTask/`) even though AutoTask is its only
/// consumer: `AutoTask/` is excluded wholesale from the lite/min feature
/// builds (`Package.swift`'s `libExcludes`), but `LibraryItemStore`'s
/// conformance to this protocol is NOT excludable — Library code is always
/// compiled — so the protocol has to live somewhere always-compiled too.
/// Same reasoning as `MobileFeatureBridge` staying in `Services/` per
/// CLAUDE.md's Mobile Control notes.
@MainActor
protocol ProjectNotesProviding: AnyObject {
    /// The project's `llm-doc/` notes, one per file. Order unspecified —
    /// callers sort by `modifiedAt` themselves.
    func projectNotes() -> [ProjectNoteRef]
}
