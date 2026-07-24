import Foundation
import SharedProtocol

/// Publishes the Mac as `_llmide._tcp` on the LAN so the iPhone can discover it.
/// Thin wrapper over NetService; Bonjour itself is not unit-testable, so this
/// class is exercised via the manual checklist.
final class MobileBonjourAdvertiser: NSObject, NetServiceDelegate {
    private let name: String
    private let port: Int
    private var service: NetService?

    init(name: String, port: Int) {
        self.name = name
        self.port = port
    }

    func start() {
        guard service == nil else { return }
        let service = NetService(domain: "", type: MobileProtocol.serviceType + ".", name: name, port: Int32(port))
        service.delegate = self
        service.publish()
        self.service = service
    }

    func stop() {
        service?.stop()
        service = nil
    }
}
