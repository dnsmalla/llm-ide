import Foundation
import SharedProtocol

/// Read-only project browsing: the desktop resolves and confines every path; the phone only names a project and a
/// project-relative path. No write, delete, shell or host path ever crosses this store.
@MainActor
final class FilesStore: ObservableObject {
    @Published private(set) var entries: [HostApiFilesListResultEntriesItem] = []
    @Published private(set) var file: HostApiFilesReadResult?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    weak var connection: ConnectionService?

    init(connection: ConnectionService) { self.connection = connection }

    private var host: HostConnection? {
        guard connection?.connectionStatus == .connected else { return nil }
        return connection?.host
    }

    func list(projectId: String, path: String = "") async {
        guard let host else { return }
        loading = true; error = nil
        do {
            entries = try await host.send(.filesList, HostApiFilesListRequest(path: path.isEmpty ? nil : path, projectId: projectId), as: HostApiFilesListResult.self).entries
                .sorted { ($0.kind == "dir" ? 0 : 1, $0.name.lowercased()) < ($1.kind == "dir" ? 0 : 1, $1.name.lowercased()) }
        } catch { self.error = message(error) }
        loading = false
    }

    func read(projectId: String, path: String) async {
        guard let host else { return }
        loading = true; error = nil
        do {
            file = try await host.send(.filesRead, HostApiFilesReadRequest(maxBytes: 200_000, path: path, projectId: projectId), as: HostApiFilesReadResult.self)
        } catch { self.error = message(error); file = nil }
        loading = false
    }

    func clear() { entries = []; file = nil; error = nil }

    private func message(_ error: Error) -> String {
        if let rejection = error as? HostApiRejection { return rejection.message }
        return error.localizedDescription
    }
}
