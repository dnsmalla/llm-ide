import Foundation
import SharedProtocol

/// The Mac's recent projects, and the request to open one. The Mac decides: it checks the id
/// against its own recents, refuses while a run is active, and answers with the resulting state.
@MainActor
final class ProjectsStore: ObservableObject {
    @Published var active: ProjectInfo?
    @Published var projects: [ProjectInfo] = []
    @Published var error: String?
    @Published var isSwitching = false
    @Published var loaded = false

    weak var connection: ConnectionService?
    private var watchdog: Task<Void, Never>?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.projectsStore = self
    }

    func refresh() {
        guard connection?.connectionStatus == .connected,
              connection?.supports(MobileProtocol.Capability.projects) == true else { return }
        connection?.sendEncodable(ProjectList())
    }

    func switchTo(_ project: ProjectInfo) {
        guard !isSwitching else { return }
        isSwitching = true
        error = nil
        connection?.sendEncodable(ProjectSwitch(id: project.id))
        watchdog?.cancel()
        // Opening a project scaffolds folders and installs skills on the Mac, so allow a while.
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled, let self, self.isSwitching else { return }
            self.error = "The Mac didn't answer. It may still be opening the project."
            self.isSwitching = false
        }
    }

    func handleInbound(type: String, data: Data) {
        guard type == MobileProtocol.Tag.projectState,
              let s = try? JSONDecoder().decode(ProjectState.self, from: data) else { return }
        active = s.active
        projects = s.projects
        error = s.error
        loaded = true
        isSwitching = false
        watchdog?.cancel()
    }

    func resetForNewDevice() {
        active = nil
        projects = []
        error = nil
        isSwitching = false
        loaded = false
        watchdog?.cancel()
    }
}
