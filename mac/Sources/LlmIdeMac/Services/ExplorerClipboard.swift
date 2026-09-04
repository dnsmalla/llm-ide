import Foundation
import Observation

/// The Explorer's own cut/copy clipboard.
///
/// Deliberately NOT `NSPasteboard`: the system pasteboard is global, so a cut
/// here would leak file paths into an unrelated ⌘V (a text field, an email,
/// another app), and any unrelated ⌘C would make the Explorer's Paste item
/// light up pointing at content it cannot use. Scope is the whole point.
///
/// A cut is NOT applied until paste: the source stays on disk and stays
/// visible in the tree, exactly like Finder and VS Code. Cancelling is just
/// never pasting.
///
/// Lives under `Services/`, not `Views/Explorer/`, because `Package.swift`
/// excludes `Views/Explorer` wholesale from a build with `file_explorer`
/// deselected but excludes NO test file — a store under `Views/Explorer/`
/// would make `ExplorerClipboardTests` fail to compile in every lite build.
@MainActor @Observable
final class ExplorerClipboard {
    enum Operation: Equatable { case cut, copy }

    private(set) var urls: [URL] = []
    private(set) var operation: Operation?

    var isEmpty: Bool { urls.isEmpty }

    /// Mark `urls` for a move on the next paste. An empty list CLEARS the
    /// clipboard rather than arming an empty operation — "cut nothing" must
    /// not leave a stale previous copy pasteable.
    func cut(_ urls: [URL]) {
        set(urls, operation: .cut)
    }

    /// Mark `urls` for duplication on the next paste. Same empty-list rule.
    func copy(_ urls: [URL]) {
        set(urls, operation: .copy)
    }

    func clear() {
        urls = []
        operation = nil
    }

    private func set(_ urls: [URL], operation: Operation) {
        guard !urls.isEmpty else { clear(); return }
        self.urls = urls
        self.operation = operation
    }
}
