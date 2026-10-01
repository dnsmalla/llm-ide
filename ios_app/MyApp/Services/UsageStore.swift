import Foundation
import SharedProtocol

/// The Mac's usage meters and edit-permission mode, read-only. Asked for when a screen needs it;
/// the Mac throttles and caches, so asking is cheap.
@MainActor
final class UsageStore: ObservableObject {
    @Published var state: UsageState?
    @Published var loadError: String?

    weak var connection: ConnectionService?
    private var watchdog: Task<Void, Never>?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.usageStore = self
    }

    /// The Mac's chip: "review" (Ask) | "acceptEdits" | "auto" (Bypass). Nil until first heard.
    var permissionMode: String? { state?.permissionMode }

    func refresh() {
        guard connection?.connectionStatus == .connected,
              connection?.supports(MobileProtocol.Capability.usage) == true else { return }
        connection?.sendEncodable(UsageGet())
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled, let self, self.state == nil,
                  self.connection?.connectionStatus == .connected else { return }
            self.loadError = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with usage."
        }
    }

    func handleInbound(type: String, data: Data) {
        guard type == MobileProtocol.Tag.usageState,
              let s = try? JSONDecoder().decode(UsageState.self, from: data) else { return }
        state = s
        loadError = nil
        watchdog?.cancel()
    }

    func resetForNewDevice() {
        state = nil
        loadError = nil
        watchdog?.cancel()
    }
}

extension UsageStore {
    /// Display label + risk for the Mac's permission chip.
    static func permissionLabel(_ raw: String?) -> (text: String, isRisky: Bool)? {
        switch raw {
        case "review":      return ("Ask", false)
        case "acceptEdits": return ("Accept Edits", false)
        case "auto":        return ("Bypass", true)
        default:            return nil
        }
    }
}
