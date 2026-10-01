import Foundation
import SharedProtocol

/// The Mac's Self-Heal incidents and proposals. Everything is decided on the Mac: the phone names an
/// incident id, the Mac looks up the proposal, enforces the Phone access switch and answers.
@MainActor
final class SelfHealStore: ObservableObject {
    @Published var state: SelfHealState?
    @Published var diffs: [String: SelfHealDiffResult] = [:]
    @Published var isBusy = false
    @Published var loadError: String?

    weak var connection: ConnectionService?
    private var watchdog: Task<Void, Never>?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.selfHealStore = self
    }

    func refresh() {
        guard connection?.connectionStatus == .connected,
              connection?.supports(MobileProtocol.Capability.selfHeal) == true else { return }
        connection?.sendEncodable(SelfHealList())
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled, let self, self.state == nil,
                  self.connection?.connectionStatus == .connected else { return }
            self.loadError = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with Self-Heal on the phone."
        }
    }

    func perform(_ action: SelfHealAction.Kind, on incident: SelfHealIncident) {
        guard !isBusy else { return }
        isBusy = true
        connection?.sendEncodable(SelfHealAction(incidentId: incident.id, action: action))
        // Apply/discard run git on the Mac; allow a while before giving the phone its screen back.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            self?.isBusy = false
        }
    }

    func loadDiff(for incident: SelfHealIncident) {
        diffs[incident.id] = nil
        connection?.sendEncodable(SelfHealDiffRequest(incidentId: incident.id))
    }

    func handleInbound(type: String, data: Data) {
        let decoder = JSONDecoder()
        switch type {
        case MobileProtocol.Tag.selfHealState:
            if let s = try? decoder.decode(SelfHealState.self, from: data) {
                state = s
                loadError = nil
                isBusy = false
                watchdog?.cancel()
            }
        case MobileProtocol.Tag.selfHealDiffResult:
            if let d = try? decoder.decode(SelfHealDiffResult.self, from: data) { diffs[d.incidentId] = d }
        default:
            break
        }
    }

    func resetForNewDevice() {
        state = nil
        diffs = [:]
        isBusy = false
        loadError = nil
        watchdog?.cancel()
    }
}
