import Foundation
import SharedProtocol

/// Serves `files_list` / `files_read`: a read-only view of the active project's code (see `PhoneFiles`
/// for what is hidden). The Phone access switch is checked on every request.
@MainActor
final class MobileFilesBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    init(manager: MobileControlManager) { self.manager = manager }

    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.filesList:
            guard let req = try? manager?.decoder.decode(FilesList.self, from: data ?? Data()) else {
                manager?.reply(FilesListing(path: "", entries: [], error: "The Mac could not read this request."))
                return true
            }
            guard let root = allowedRoot(whenDenied: { manager?.reply(FilesListing(path: req.path, entries: [], error: $0)) }) else { return true }
            Task { [weak self] in
                let listing = await Task.detached { PhoneFiles.list(root: root, relative: req.path) }.value
                self?.manager?.reply(listing)
            }
            return true
        case MobileProtocol.Tag.filesRead:
            guard let req = try? manager?.decoder.decode(FilesRead.self, from: data ?? Data()) else {
                manager?.reply(FilesFile(path: "", text: nil, error: "The Mac could not read this request."))
                return true
            }
            guard let root = allowedRoot(whenDenied: { manager?.reply(FilesFile(path: req.path, text: nil, error: $0)) }) else { return true }
            Task { [weak self] in
                let file = await Task.detached { PhoneFiles.read(root: root, relative: req.path) }.value
                self?.manager?.reply(file)
            }
            return true
        default:
            return false
        }
    }
    func installPushObservers() {}
    func removePushObservers() {}

    private func allowedRoot(whenDenied: (String) -> Void) -> URL? {
        guard manager?.phoneAccess.isAllowed(.fileBrowse) == true else {
            whenDenied(PhoneAccess.fileBrowse.deniedMessage)
            return nil
        }
        guard let root = manager?.mobileWorkspaceURL() else {
            whenDenied("Open a project on the Mac first.")
            return nil
        }
        return root
    }
}
