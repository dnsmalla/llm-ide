import Foundation

public enum CodeNoteError: Error, Equatable {
    case folderNotWritable(path: String)
    case analyzeFailed(batch: Int, message: String)
    case cancelled
}
