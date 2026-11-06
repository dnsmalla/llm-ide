import Foundation
import SharedProtocol

/// The host's usage meters and edit-permission mode, read-only. Asked for when a screen needs it;
/// the host throttles and caches, so asking is cheap.
@MainActor
final class UsageStore: ObservableObject {
    @Published var state: UsageState?
    @Published var loadError: String?

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.usageStore = self
    }

    /// The host's chip: "review" (Ask) | "acceptEdits" | "auto" (Bypass). Nil until first heard.
    var permissionMode: String? { state?.permissionMode }

    private var v1Ticket = 0

    /// Host API v1 `usage.get` (capability `read`), mapped into `UsageState`.
    func refresh() {
        guard let connection, connection.connectionStatus == .connected, connection.servesV1Read else { return }
        v1Ticket += 1
        let mine = v1Ticket
        loadError = nil
        let host = connection.host
        Task { [weak self] in
            do {
                let r = try await host.send(.usageGet, HostApiUsageGetRequest(), as: HostApiUsageGetResult.self)
                guard let self, mine == self.v1Ticket, self.connection?.servesV1Read == true else { return }
                self.state = HostApiReadMapping.usageState(r)
            } catch {
                guard let self, mine == self.v1Ticket else { return }
                let text = (error as? HostApiRejection)?.message ?? ""
                self.loadError = text.isEmpty ? "Your host sent usage this app could not read." : String(text.prefix(500))
            }
        }
    }

    func resetForNewDevice() {
        v1Ticket += 1
        state = nil
        loadError = nil
    }
}

extension UsageStore {
    /// Display label + risk for the host's permission chip.
    static func permissionLabel(_ raw: String?) -> (text: String, isRisky: Bool)? {
        switch raw {
        case "review":      return ("Ask", false)
        case "acceptEdits": return ("Accept Edits", false)
        case "auto":        return ("Bypass", true)
        default:            return nil
        }
    }
}
