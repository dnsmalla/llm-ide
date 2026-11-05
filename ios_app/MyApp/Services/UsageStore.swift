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

    private var v1Ticket = 0

    func refresh() {
        guard let connection, connection.connectionStatus == .connected else { return }
        if connection.servesV1Read { return refreshV1(connection) }
        guard connection.supports(MobileProtocol.Capability.usage) else { return }
        connection.sendEncodable(UsageGet())
        loadError = nil
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled, let self, self.state == nil,
                  self.connection?.connectionStatus == .connected else { return }
            self.loadError = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with usage."
        }
    }

    /// Host API v1: `usage.get` (capability `read`), mapped into the same `UsageState` the v2 screen shows.
    private func refreshV1(_ connection: ConnectionService) {
        v1Ticket += 1
        let mine = v1Ticket
        loadError = nil
        watchdog?.cancel()
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

    func handleInbound(type: String, data: Data) {
        guard type == MobileProtocol.Tag.usageState,
              let s = try? JSONDecoder().decode(UsageState.self, from: data) else { return }
        state = s
        loadError = nil
        watchdog?.cancel()
    }

    func resetForNewDevice() {
        v1Ticket += 1
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
