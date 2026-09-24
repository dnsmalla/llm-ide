import Foundation

/// Unsaved editor text, per file, kept ABOVE the editor views.
///
/// `EditableTextDetailView` held its buffer in view-local `@State`, and every
/// host renders it under `.id(url)`: switching tabs, renaming or deleting a
/// file, closing a tab, or switching projects destroyed the view — and with it
/// every unsaved edit, with no prompt. The editor now mirrors its buffer here
/// on every keystroke while it is dirty, restores it when the same file is
/// opened again (only if the file on disk is still what the draft was based
/// on), and the tab bar asks before closing a tab that has one.
///
/// In-memory only: a draft is recovery from the app's OWN view churn, not from
/// a crash. Keyed by standardized path so every host addresses a file the same
/// way (`ExplorerPaths.key` is stricter — case/symlink canonical — but the
/// same URL instance flows through tabs, so the standardized path is enough
/// and avoids a disk hit per keystroke).
@MainActor
final class EditorDraftStore: ObservableObject {
    static let shared = EditorDraftStore()

    struct Draft: Equatable {
        /// The unsaved buffer.
        var content: String
        /// The file's content the buffer was edited from. A restore is only
        /// offered while the file on disk still equals this — otherwise
        /// something else changed the file and the draft would clobber it.
        var base: String
    }

    @Published private(set) var drafts: [String: Draft] = [:]

    init() {}

    static func key(_ url: URL) -> String { url.standardizedFileURL.path }

    func draft(for url: URL) -> Draft? { drafts[Self.key(url)] }

    func hasDraft(_ url: URL) -> Bool { drafts[Self.key(url)] != nil }

    /// Record the editor's live buffer. A buffer equal to its base is not a
    /// draft (the file is clean) and clears any earlier one.
    func stash(_ url: URL, content: String, base: String) {
        let k = Self.key(url)
        if content == base {
            if drafts[k] != nil { drafts[k] = nil }
        } else {
            let next = Draft(content: content, base: base)
            if drafts[k] != next { drafts[k] = next }
        }
    }

    /// Saved or reverted: nothing unsaved remains for this file.
    func discard(_ url: URL) {
        let k = Self.key(url)
        if drafts[k] != nil { drafts[k] = nil }
    }

    /// The file (or a folder containing it) was renamed or moved: the draft
    /// follows it, so the edit is not lost to the rename.
    func rename(from old: URL, to new: URL) {
        let oldKey = Self.key(old), newKey = Self.key(new)
        guard oldKey != newKey else { return }
        var next: [String: Draft] = [:]
        for (k, d) in drafts {
            if k == oldKey {
                next[newKey] = d
            } else if k.hasPrefix(oldKey + "/") {
                next[newKey + k.dropFirst(oldKey.count)] = d
            } else {
                next[k] = d
            }
        }
        if next != drafts { drafts = next }
    }

    /// The file or folder is gone (deleted, trashed): its drafts with it.
    func discardAll(under url: URL) {
        let k = Self.key(url)
        let next = drafts.filter { !($0.key == k || $0.key.hasPrefix(k + "/")) }
        if next.count != drafts.count { drafts = next }
    }

    /// Sign-out / project close hygiene when a caller wants a clean slate.
    func removeAll() {
        if !drafts.isEmpty { drafts = [:] }
    }
}
