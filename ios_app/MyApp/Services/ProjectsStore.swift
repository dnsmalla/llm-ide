import Foundation
import SharedProtocol

/// Owns the chat's project scope over Host API v1 `host`: load `projects.list` after pairing/sign-in,
/// remember the selected project per host, and keep the host's PROJECT_* refusal for the picker to show.
/// The wire logic (and its tests) lives in `HostApiProjectController`; this type only owns app storage.
@MainActor
final class ProjectsStore: ObservableObject {
    @Published private(set) var state = HostApiProjectsState()

    var selectedId: String? { state.selectedId }
    var selectedProject: HostApiProjectsListResultProjectsItem? {
        state.projects.first(where: { $0.id == state.selectedId })
    }

    private weak var connection: ConnectionService?
    private weak var connectionStore: ConnectionStore?
    private let controller: HostApiProjectController

    /// The choice is per host and is not a secret: the host returns `projects.list` to any paired device.
    private static let keyPrefix = "llmide.hostApi.v1.project."

    init(connection: ConnectionService, connectionStore: ConnectionStore) {
        self.connection = connection
        self.connectionStore = connectionStore
        let store = connectionStore
        controller = HostApiProjectController(
            host: { [weak connection] in connection?.host },
            storedId: { [weak store] in Self.read(host: store?.deviceIP) },
            persist: { [weak store] id in Self.write(id, host: store?.deviceIP) })
        controller.onChange = { [weak self] state in self?.state = state }
        connection.projectsStore = self
    }

    /// Ask the connected host for its projects. Called on connect, on appear, and after a resync.
    func refresh() {
        guard connection?.connectionStatus == .connected else { return }
        Task { await controller.refresh() }
    }

    /// Pick a project the host offered; returns false for an unknown id.
    @discardableResult
    func select(_ id: String) -> Bool { controller.select(id) }

    /// Route a refused frame's reason to the picker. Returns false for an error that is not project-scoped.
    @discardableResult
    func noteRefusal(_ error: Error) -> Bool { controller.noteRefusal(error) != nil }

    func clearRefusal() { controller.clearRefusal() }

    /// A newly paired desktop: drop the previous list, keep that host's stored choice for next time.
    func resetForNewDevice() {
        controller.reset()
        if state != HostApiProjectsState() { state = HostApiProjectsState() }
    }

    // MARK: — Per-host persistence

    private static func key(host: String?) -> String {
        let name = (host?.isEmpty == false) ? host! : "unknown"
        return keyPrefix + name
    }

    /// Same shape the contract allows for `projectId`, so a corrupt defaults value can never reach a frame.
    private static func valid(_ raw: String?) -> String? {
        guard let raw, raw.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { return nil }
        return raw
    }

    private static func read(host: String?) -> String? {
        valid(UserDefaults.standard.string(forKey: key(host: host)))
    }

    private static func write(_ id: String?, host: String?) {
        let key = key(host: host)
        if let id = valid(id) {
            UserDefaults.standard.set(id, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
