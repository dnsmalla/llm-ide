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

    init(connection: ConnectionService, connectionStore: ConnectionStore) {
        self.connection = connection
        self.connectionStore = connectionStore
        let store = connectionStore
        controller = HostApiProjectController(
            host: { [weak connection] in connection?.host },
            storedId: { [weak store] in Self.read(store) },
            persist: { [weak store] id in Self.write(id, store) })
        controller.onChange = { [weak self] state in self?.state = state }
        connection.projectsStore = self
    }

    /// Ask the connected host for its projects. Called on connect, on appear, and after a resync.
    func refresh() {
        guard connection?.connectionStatus == .connected else { return }
        Task { await controller.refresh() }
    }

    /// Wait for the first projects.list reply (the chat's first snapshot/send is gated on it).
    func waitUntilLoaded() async { await controller.waitUntilLoaded() }

    /// The project the next scoped frame should name, after the list has answered.
    func projectIdForScopedFrame() async -> String? { await controller.projectIdForScopedFrame() }

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

    /// The choice is keyed by the host's stable identity (pinned fingerprint), not its address: a DHCP
    /// change keeps the choice, and a second desktop that inherits the old IP does not inherit it.
    private static func read(_ store: ConnectionStore?) -> String? {
        guard let store else { return nil }
        let stable = HostApiProjectStorage.key(pinnedFingerprint: store.hostApiPin, address: store.deviceIP)
        if let found = valid(UserDefaults.standard.string(forKey: stable)) { return found }
        // A choice saved before the fingerprint key existed lived under the bare address (or "unknown").
        // Read it once; the next persist migrates it and removes the old key.
        let legacy = HostApiProjectStorage.keyPrefix + Self.legacyName(store.deviceIP)
        return valid(UserDefaults.standard.string(forKey: legacy))
    }

    private static func write(_ id: String?, _ store: ConnectionStore?) {
        guard let store else { return }
        let stable = HostApiProjectStorage.key(pinnedFingerprint: store.hostApiPin, address: store.deviceIP)
        if let id = valid(id) {
            UserDefaults.standard.set(id, forKey: stable)
        } else {
            UserDefaults.standard.removeObject(forKey: stable)
        }
        // Drop a pre-L6 address-keyed value after migrating it, so an old address cannot leak this host's
        // choice to another. (With no pin and no address the two keys are the same one.)
        let legacy = HostApiProjectStorage.keyPrefix + Self.legacyName(store.deviceIP)
        if legacy != stable { UserDefaults.standard.removeObject(forKey: legacy) }
    }

    private static func legacyName(_ address: String) -> String {
        address.isEmpty ? "unknown" : address
    }

    /// Same shape the contract allows for `projectId`, so a corrupt defaults value can never reach a frame.
    private static func valid(_ raw: String?) -> String? {
        guard let raw, raw.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { return nil }
        return raw
    }
}
