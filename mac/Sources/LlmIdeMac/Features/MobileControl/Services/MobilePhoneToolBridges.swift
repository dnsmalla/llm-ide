import Foundation
import SharedProtocol

/// The phone's read/act-on-the-Mac bridges that need nothing but the manager. Registered through
/// `register(...)`, so adding one is a local change here rather than another slot + routing Set
/// on `MobileControlManager`. Each declares the capabilities it advertises and which
/// `PhoneAccess` switch (if any) must be ON for a capability to be offered.
extension MobileControlManager {
    func registerPhoneToolBridges() {
        guard registeredBridges.isEmpty else { return }   // idempotent across boot paths
        register(bridge: MobileUsageBridge(manager: self),
                 messageTypes: [MobileProtocol.Tag.usageGet],
                 capabilities: [(name: MobileProtocol.Capability.usage, gate: nil)])
    }
}
