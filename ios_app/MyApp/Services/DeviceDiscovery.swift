import Foundation

struct DiscoveredDevice: Identifiable, Equatable {
    var id: String { name }
    let name: String
    let host: String
    let port: Int
}

/// Discovers AI Control agents on the local network via Bonjour (_aicontrol._tcp).
@MainActor
final class DeviceDiscovery: NSObject, ObservableObject {
    @Published var devices: [DiscoveredDevice] = []
    @Published var isSearching: Bool = false

    private let browser = NetServiceBrowser()
    private var pending: [NetService] = []

    func start() {
        isSearching = true
        browser.delegate = self
        browser.searchForServices(ofType: "_aicontrol._tcp.", inDomain: "local.")
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
        Task { @MainActor in
            self.pending.removeAll { $0 === service }
            self.devices.removeAll { $0.name == service.name }
        }
    }
}

extension DeviceDiscovery: NetServiceDelegate {
    nonisolated func netServiceDidResolveAddress(_ sender: NetService) {
        guard let ip = sender.ipv4Address else { return }
        let device = DiscoveredDevice(name: sender.name, host: ip, port: sender.port)
        Task { @MainActor in
            self.devices.removeAll { $0.name == sender.name }
            self.devices.append(device)
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
