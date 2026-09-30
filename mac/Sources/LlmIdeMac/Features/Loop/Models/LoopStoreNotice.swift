import Foundation

/// Something the user must be told about a project's `system/loop.json` that
/// the static, UI-free `LoopEngineConfigStore` cannot show itself: the file
/// was set aside as undecodable, could not be read, or was written by a newer
/// build (so this build will not overwrite it). Keyed by file path; the Loop
/// page reads it and listens for `LoopStoreNotices.didChange`.
enum LoopStoreNotice: Equatable {
    case quarantined(movedTo: String?)
    case newerVersion(Int)
    case readFailed

    var message: String {
        switch self {
        case let .quarantined(movedTo):
            return "loop.json could not be decoded"
                + (movedTo.map { " and was moved aside to \($0)" } ?? "")
                + ". The Loop page started from defaults."
        case let .newerVersion(version):
            return "loop.json was written by a newer LLM-IDE (schema \(version)). "
                + "It is read-only here — changes will not be saved until you update."
        case .readFailed:
            return "loop.json could not be read. It was left untouched and changes will not be saved."
        }
    }
}

final class LoopStoreNotices: @unchecked Sendable {
    static let shared = LoopStoreNotices()
    static let didChange = Notification.Name("llmide.loopStoreNoticeChanged")

    private let lock = NSLock()
    private var byPath: [String: LoopStoreNotice] = [:]

    func post(_ notice: LoopStoreNotice, forFile url: URL) {
        lock.lock()
        let changed = byPath[url.path] != notice
        byPath[url.path] = notice
        lock.unlock()
        guard changed else { return }
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.didChange, object: nil)
        }
    }

    func notice(forFile url: URL) -> LoopStoreNotice? {
        lock.lock()
        defer { lock.unlock() }
        return byPath[url.path]
    }

    func clear(forFile url: URL) {
        lock.lock()
        let had = byPath.removeValue(forKey: url.path) != nil
        lock.unlock()
        if had {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Self.didChange, object: nil)
            }
        }
    }
}
