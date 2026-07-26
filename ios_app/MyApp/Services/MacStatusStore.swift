import Foundation
import SharedProtocol

/// Read-only Mac environment snapshot for the home status strip (Phase A).
@MainActor
final class MacStatusStore: ObservableObject {
    @Published var macStatus: MacStatus?

    weak var connection: ConnectionService?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.macStatusStore = self
    }

    func requestMacStatus() {
        connection?.sendEncodable(MacStatusList())
    }

    func handleInbound(type: String, data: Data) {
        guard type == "mac_status" else { return }
        if let status = try? JSONDecoder().decode(MacStatus.self, from: data) {
            macStatus = status
        }
    }
}
