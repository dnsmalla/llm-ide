import Foundation
import SharedProtocol

/// Read-only mirror of the Mac project's files. Listings and file text are cached by project-relative
/// path and dropped when the Mac's project changes.
@MainActor
final class FilesStore: ObservableObject {
    @Published var listings: [String: FilesListing] = [:]
    @Published var files: [String: FilesFile] = [:]

    weak var connection: ConnectionService?
    private var watchdogs: [String: Task<Void, Never>] = [:]
    static let replyTimeout: TimeInterval = 8

    init(connection: ConnectionService) {
        self.connection = connection
        connection.filesStore = self
    }

    private var isConnected: Bool { connection?.connectionStatus == .connected }

    func list(_ path: String) {
        guard isConnected else { return }
        connection?.sendEncodable(FilesList(path: path))
        watch("list:\(path)") { [weak self] in
            guard let self, self.listings[path] == nil, self.isConnected else { return }
            self.listings[path] = FilesListing(path: path, entries: [], error: Self.oldMac)
        }
    }

    func read(_ path: String) {
        guard isConnected else { return }
        connection?.sendEncodable(FilesRead(path: path))
        watch("read:\(path)") { [weak self] in
            guard let self, self.files[path] == nil, self.isConnected else { return }
            self.files[path] = FilesFile(path: path, text: nil, error: Self.oldMac)
        }
    }

    func invalidate(_ path: String) {
        listings[path] = nil
        files[path] = nil
    }

    func handleInbound(type: String, data: Data) {
        let decoder = JSONDecoder()
        switch type {
        case MobileProtocol.Tag.filesListing:
            if let l = try? decoder.decode(FilesListing.self, from: data) {
                listings[l.path] = l
                clear("list:\(l.path)")
            }
        case MobileProtocol.Tag.filesFile:
            if let f = try? decoder.decode(FilesFile.self, from: data) {
                files[f.path] = f
                clear("read:\(f.path)")
            }
        default:
            break
        }
    }

    /// The Mac opened another project: the old tree's listings and files mean nothing now.
    func invalidateAll() {
        listings = [:]
        files = [:]
    }

    func resetForNewDevice() {
        invalidateAll()
        watchdogs.values.forEach { $0.cancel() }
        watchdogs = [:]
    }

    static let oldMac = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with the file viewer, and make sure a project is open."

    private func clear(_ key: String) {
        watchdogs[key]?.cancel()
        watchdogs[key] = nil
    }

    private func watch(_ key: String, onTimeout: @escaping @MainActor () -> Void) {
        watchdogs[key]?.cancel()
        watchdogs[key] = Task {
            try? await Task.sleep(nanoseconds: UInt64(Self.replyTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await onTimeout()
        }
    }
}
