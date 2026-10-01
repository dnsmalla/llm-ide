import Foundation
import SharedProtocol

/// The phone's read/act-on-the-Mac bridges that need nothing but the manager. Registered through
/// `register(...)`, so adding one is a local change here rather than another slot + routing Set
/// on `MobileControlManager`. Each declares the capabilities it advertises and which
/// `PhoneAccess` switch (if any) must be ON for a capability to be offered.
extension MobileControlManager {
    func registerPhoneToolBridges() {
        guard registeredBridges.isEmpty else { return }   // idempotent across boot paths
        let projects = MobileProjectBridge(manager: self)
        projectBridge = projects
        register(bridge: projects,
                 messageTypes: [MobileProtocol.Tag.projectList, MobileProtocol.Tag.projectSwitch],
                 capabilities: [(name: MobileProtocol.Capability.projects, gate: .projectSwitch)])
        let selfHeal = MobileSelfHealBridge(manager: self)
        selfHealBridge = selfHeal
        register(bridge: selfHeal,
                 messageTypes: [MobileProtocol.Tag.selfHealList, MobileProtocol.Tag.selfHealAction,
                                MobileProtocol.Tag.selfHealDiff],
                 capabilities: [(name: MobileProtocol.Capability.selfHeal, gate: nil),
                                (name: MobileProtocol.Capability.selfHealApply, gate: .selfHealApply)])
        // Tool prompts ride the existing chat arms (no message types of their own to route), so this
        // registration exists only to advertise the capability behind its switch.
        register(bridge: NoMessagesBridge(), messageTypes: [],
                 capabilities: [(name: MobileProtocol.Capability.toolApprovals, gate: .toolApprovals)])
        register(bridge: MobileSourceControlBridge(manager: self),
                 messageTypes: [MobileProtocol.Tag.scmStatusList, MobileProtocol.Tag.scmDiff],
                 capabilities: [(name: MobileProtocol.Capability.sourceControl, gate: .sourceControlRead)])
        register(bridge: MobileUsageBridge(manager: self),
                 messageTypes: [MobileProtocol.Tag.usageGet],
                 capabilities: [(name: MobileProtocol.Capability.usage, gate: nil)])
    }
}

/// A bridge that serves no message types; lets a capability be advertised (behind a Phone access
/// switch) for behaviour implemented elsewhere in the manager.
@MainActor
final class NoMessagesBridge: MobileFeatureBridge {
    func handle(type: String, data: Data?) -> Bool { false }
    func installPushObservers() {}
    func removePushObservers() {}
}
