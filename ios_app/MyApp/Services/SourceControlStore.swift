import Foundation
import SharedProtocol

/// Read-only mirror of the Mac project's git state. Nothing here changes the repo.
@MainActor
final class SourceControlStore: ObservableObject {
    @Published var state: ScmState?
    @Published var diffs: [String: ScmDiffResult] = [:]
    @Published var loadError: String?

    weak var connection: ConnectionService?
    private var watchdog: Task<Void, Never>?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.sourceControlStore = self
    }

    static func key(_ path: String, _ staged: Bool) -> String { (staged ? "S:" : "W:") + path }

    func refresh() {
        guard connection?.connectionStatus == .connected,
              connection?.supports(MobileProtocol.Capability.sourceControl) == true else { return }
        connection?.sendEncodable(ScmStatusList())
        loadError = nil
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled, let self, self.state == nil,
                  self.connection?.connectionStatus == .connected else { return }
            self.loadError = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with Source Control on the phone."
        }
    }

    func loadDiff(_ file: ScmFile) {
        diffs[Self.key(file.path, file.staged)] = nil
        connection?.sendEncodable(ScmDiffRequest(path: file.path, staged: file.staged))
    }

    func handleInbound(type: String, data: Data) {
        let decoder = JSONDecoder()
        switch type {
        case MobileProtocol.Tag.scmState:
            if let s = try? decoder.decode(ScmState.self, from: data) {
                state = s
                loadError = nil
                watchdog?.cancel()
            }
        case MobileProtocol.Tag.scmDiffResult:
            if let d = try? decoder.decode(ScmDiffResult.self, from: data) { diffs[Self.key(d.path, d.staged)] = d }
        default:
            break
        }
    }

    /// The Mac's project changed: the old tree's state and diffs mean nothing now.
    func invalidate() {
        state = nil
        diffs = [:]
    }

    func resetForNewDevice() {
        invalidate()
        loadError = nil
        watchdog?.cancel()
    }
}
