import CryptoKit
import Foundation

/// Files the APP itself wrote, with the digest of what it wrote.
///
/// The repair guard protects a few harness files (for example a loop's own
/// contract, `system/loop.json`) from the agent it supervises. But the app
/// writes those files too — stage re-detection and the editor's autosave — and
/// from the guard's point of view an app write during a run is
/// indistinguishable from an agent edit. Recording the digest of each app write
/// lets the guard tell them apart: a file whose CURRENT content still equals the
/// last app write is the app's; any other content is someone else's edit. An
/// agent cannot use this to hide an edit, because matching the digest means
/// leaving the file exactly as the app wrote it.
///
/// Only writes the USER/UI initiated may be recorded. A background re-save that
/// merely normalises what it just READ (stage re-detection, legacy migration)
/// would otherwise re-save an agent's edited file and record the edit as the
/// app's own — those writers must not call `recordWrite`.
///
/// NOTE: process-wide state on purpose — the writer (a store) and the reader (the
/// guard) share no object, and both are in the same process. Lock-guarded.
enum AppWrittenFiles {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var digests: [String: String] = [:]

    private static func key(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Call right after the app successfully wrote `data` to `url`.
    static func recordWrite(of data: Data, to url: URL) {
        let k = key(url), d = digest(data)
        lock.lock(); defer { lock.unlock() }
        digests[k] = d
    }

    /// Record `url`'s CURRENT content as the app's own. Called when a
    /// supervised edit starts: what is on disk then predates the agent, so a
    /// UI save made later in the run can tell whether the file it is about to
    /// rewrite was changed by someone else in between (see
    /// `LoopEngineConfigStore.save`). A no-op when the file cannot be read.
    static func adoptCurrentContent(of url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        recordWrite(of: data, to: url)
    }

    /// True when `url` exists and still holds exactly what the app last wrote to it.
    static func isUnchangedSinceAppWrite(_ url: URL) -> Bool {
        let k = key(url)
        lock.lock(); let recorded = digests[k]; lock.unlock()
        guard let recorded, let data = try? Data(contentsOf: url) else { return false }
        return digest(data) == recorded
    }
}
