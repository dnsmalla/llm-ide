import Foundation

public enum CodeNoteError: Error, Equatable {
    case folderNotWritable(path: String)
    case analyzeFailed(batch: Int, message: String)
    case cancelled
    /// Another run already holds this repository's scan lock.
    ///
    /// Distinct from a failure: nothing is wrong, the caller simply did not get
    /// a scan. It used to be reported as `.success` with whatever graph was
    /// current, which made callers act on an empty graph as if it were real.
    case busy
    /// No graph engine is installed, so nothing can be scanned.
    case noEngine
    /// The engine ran and failed.
    case engineFailed(String)
}

extension CodeNoteError: LocalizedError {
    /// Wording shown directly to the user.
    ///
    /// Every failure used to reuse `folderNotWritable`, so a plugin engine
    /// crashing reported as "folder not writable" — which sent anyone
    /// debugging it after the wrong thing entirely.
    public var errorDescription: String? {
        switch self {
        case let .folderNotWritable(path):
            return "Cannot write to \(path)"
        case let .analyzeFailed(batch, message):
            return "Note enrichment batch \(batch) failed: \(message)"
        case .cancelled:
            return "Cancelled"
        case .busy:
            return "Another scan of this repository is already running"
        case .noEngine:
            return "No graph engine installed. Add one from Library → Plugins."
        case let .engineFailed(message):
            return "The graph engine failed: \(message)"
        }
    }
}
