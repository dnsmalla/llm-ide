import Foundation

public enum CodeNoteError: Error, Equatable {
    case cliMissing
    case folderNotWritable(path: String)
    case scanFailed(message: String)
    case analyzeFailed(batch: Int, message: String)
    case noScanOutput
    case parseFailed(message: String)
    case cancelled
}
