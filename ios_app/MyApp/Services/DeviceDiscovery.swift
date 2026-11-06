import Foundation
import SharedProtocol

struct DiscoveredDevice: Identifiable, Equatable {
    var id: String { "\(name)@\(host)" }
    let name: String
    let host: String
    let port: Int
    /// From the TXT record (`h1port` + `h1fp`). Used only when the user pairs with this Mac; a TXT record on its
    /// own never changes a stored pin (`HostApiPinning.pinAfterOffer`).
    var hostApiOffer: HostApiPairingOffer? = nil
}

/// Discovers LLM-IDE Mac apps on the local network via Bonjour (_llmide._tcp).
@MainActor
final class DeviceDiscovery: NSObject, ObservableObject {
    @Published var devices: [DiscoveredDevice] = []
    @Published var isSearching: Bool = false
    /// Every resolved service, as it resolves.
    var onResolve: ((DiscoveredDevice) -> Void)?

    private let browser = NetServiceBrowser()
    private var pending: [NetService] = []

    func start() {
        devices = []
        isSearching = true
        browser.delegate = self
        browser.searchForServices(ofType: MobileProtocol.serviceType + ".", inDomain: "local.")
    }

    func stop() {
        browser.stop()
        pending.removeAll()
        isSearching = false
    }
}

extension DeviceDiscovery: NetServiceBrowserDelegate {
    nonisolated func netServiceBrowser(_ browser: NetServiceBrowser,
                                       didFind service: NetService,
                                       moreComing: Bool) {
        service.delegate = self
        service.resolve(withTimeout: 5)
        Task { @MainActor in self.pending.append(service) }
    }

    nonisolated func netServiceBrowser(_ browser: NetServiceBrowser,
                                       didRemove service: NetService,
                                       moreComing: Bool) {
        let host = service.ipv4Address
        Task { @MainActor in
            self.pending.removeAll { $0 === service }
            // A service whose address is gone cannot be told apart from its same-named peers; drop by name then.
            self.devices.removeAll { $0.name == service.name && (host == nil || $0.host == host) }
        }
    }
}

extension DeviceDiscovery: NetServiceDelegate {
    nonisolated func netServiceDidResolveAddress(_ sender: NetService) {
        guard let ip = sender.ipv4Address else { return }
        let txt = sender.txtRecordData().map(NetService.dictionary(fromTXTRecord:)) ?? [:]
        let field = { (key: String) in txt[key].flatMap { String(data: $0, encoding: .utf8) } }
        let device = DiscoveredDevice(name: sender.name, host: ip, port: sender.port,
                                      hostApiOffer: HostApiPairingOffer(port: field("h1port"), fingerprint: field("h1fp")))
        Task { @MainActor in
            self.devices.removeAll { $0.name == sender.name && $0.host == device.host }
            self.devices.append(device)
            self.onResolve?(device)
        }
    }

    nonisolated func netService(_ sender: NetService,
                                didNotResolve errorDict: [String: NSNumber]) {
        Task { @MainActor in self.pending.removeAll { $0 === sender } }
    }
}

private extension NetService {
    var ipv4Address: String? {
        guard let addresses else { return nil }
        for data in addresses {
            var storage = sockaddr_storage()
            (data as NSData).getBytes(&storage, length: MemoryLayout.size(ofValue: storage))
            guard Int32(storage.ss_family) == AF_INET else { continue }
            return withUnsafePointer(to: &storage) { ptr in
                ptr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { sin in
                    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                    var addr = sin.pointee.sin_addr
                    inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN))
                    return String(cString: buf)
                }
            }
        }
        return nil
    }
}
