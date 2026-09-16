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

    /// Backstop for any path that releases the advertiser without calling
    /// `stop()`, so a stale `_llmide._tcp` record can't keep advertising a
    /// port nothing is listening on. `stop()` here is synchronous, so unlike
    /// `MobileWebSocketServer` this class never had the dropped-teardown bug —
    /// this is belt-and-braces for the same class of resource.
    ///
    /// `NetService` is run-loop bound and expects its methods on the thread
    /// that published it. That holds here because the only owner is the
    /// `@MainActor` `MobileControlManager`, so both `start()` and this deinit
    /// run on the main thread. Anything that takes ownership off the main
    /// actor must call `stop()` explicitly rather than relying on this.
    deinit {
        service?.stop()
    }
}
