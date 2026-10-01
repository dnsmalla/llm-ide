import Foundation
import SharedProtocol

/// Serves `project_list` / `project_switch`: lists the Mac's recent projects (ids and names only)
/// and switches the active one. A switch is heavyweight on the Mac — it rebuilds the app
/// environment and resets generation state — so it is refused while anything is running, and the
/// phone can only name a project by an id the Mac itself issued.
@MainActor
final class MobileProjectBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    /// Why a switch must wait right now (a loop or auto task is running), or nil. Injected by the
    /// shell because the run guards live in features that may be compiled out.
    var busyReason: (() -> String?)?

    static let maxProjects = 20

    init(manager: MobileControlManager) { self.manager = manager }

    // MARK: - MobileFeatureBridge

    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.projectList:
            manager?.reply(currentState())
            return true
        case MobileProtocol.Tag.projectSwitch:
            guard let req = try? manager?.decoder.decode(ProjectSwitch.self, from: data ?? Data()) else {
                manager?.reply(currentState(error: "The Mac could not read this request."))
                return true
            }
            perform(req.id)
            return true
        default:
            return false
        }
    }
    func installPushObservers() {}
    func removePushObservers() {}

    // MARK: - Switching

    enum Decision: Equatable {
        case go(String)
        case refuse(String)
    }

    /// Pure so a test can pin every refusal. The id must be one of the Mac's own recents.
    nonisolated static func decide(requestedId: String, recentIds: [String], activeId: String?,
                                   allowed: Bool, isExporting: Bool, busyReason: String?) -> Decision {
        guard allowed else { return .refuse(PhoneAccess.projectSwitch.deniedMessage) }
        guard recentIds.contains(requestedId) else {
            return .refuse("That project isn't in the Mac's recent list any more. Refresh and try again.")
        }
        if requestedId == activeId { return .refuse("That project is already open.") }
        if isExporting { return .refuse("The Mac is exporting the current project. Try again in a moment.") }
        if let busyReason { return .refuse(busyReason) }
        return .go(requestedId)
    }

    private func perform(_ id: String) {
        guard let manager, let store = manager.projectStore else { return }
        let decision = Self.decide(requestedId: id,
                                   recentIds: store.recents.map(\.id),
                                   activeId: store.activeProject?.bundle.id,
                                   allowed: manager.phoneAccess.isAllowed(.projectSwitch),
                                   isExporting: store.isExporting,
                                   busyReason: busyReason?())
        switch decision {
        case .refuse(let why):
            manager.reply(currentState(error: why))
        case .go(let id):
            guard let entry = store.recents.first(where: { $0.id == id }) else { return }
            if ProjectStore.isOnUnmountedVolume(entry.path) {
                manager.reply(currentState(error: "That project is on a drive that isn't connected to the Mac."))
                return
            }
            do {
                try store.switchTo(recent: entry)
                manager.append(.info, "project_switch -> \(entry.displayName)")
                manager.reply(currentState())
            } catch {
                manager.reply(currentState(error: error.localizedDescription))
            }
        }
    }

    // MARK: - State

    private func currentState(error: String? = nil) -> ProjectState {
        guard let store = manager?.projectStore else {
            return ProjectState(active: nil, projects: [], error: error ?? "No project store.")
        }
        return Self.state(
            active: store.activeProject.map { ($0.bundle.id, $0.bundle.displayName) },
            recents: store.recents.map { ($0.id, $0.displayName, $0.lastOpenedAt) },
            error: error)
    }

    nonisolated static func state(active: (id: String, name: String)?,
                                  recents: [(id: String, name: String, opened: Date)],
                                  error: String?) -> ProjectState {
        ProjectState(
            active: active.map { ProjectInfo(id: $0.id, name: $0.name) },
            projects: recents.prefix(maxProjects).map {
                ProjectInfo(id: $0.id, name: $0.name, lastOpenedAt: $0.opened.timeIntervalSince1970)
            },
            error: error)
    }
}
