import Foundation
@testable import LlmIdeMacLib

/// A recording `MobileBridgeHosting` for bridge tests: no socket, no manager, no UserDefaults.
/// Replies are captured so a test can assert exactly what the phone would have been told.
@MainActor
final class PhoneBridgeSpyHost: MobileBridgeHosting {
    var config: AppConfig?
    var projectStore: ProjectStore?
    var mobileClientPaired = true
    var allowed: Set<String> = []
    var autoTaskRequest: MobileAutoTaskRequest?
    var loopRequest: MobileLoopRequest?
    var loopReplies: [MobileLoopReply] = []
    var autoTaskReplies: [MobileAutoTaskReply] = []
    var commandErrors: [(commandId: String, message: String, code: String?)] = []
    var infoLines: [String] = []
    /// Scripted answers for `requestDesktopApproval`, consumed in order; empty means `.approved`.
    var approvalOutcomes: [PhoneDesktopApprovalOutcome] = []
    var approvalRequests: [PhoneDesktopApprovalRequest] = []

    func isPhoneAccessAllowed(_ access: MobileBridgeAccess) -> Bool {
        allowed.contains(String(describing: access))
    }
    func allow(_ access: MobileBridgeAccess) { allowed.insert(String(describing: access)) }
    func phoneAccessDeniedMessage(_ access: MobileBridgeAccess) -> String { "denied" }
    var phoneTextRedactor: @Sendable (String) -> String { { $0 } }
    func logInfo(_ text: String) { infoLines.append(text) }
    func logError(_ text: String) { infoLines.append("ERR " + text) }
    func logDecodeFailure(type: String, data: Data?) {}
    func replyCommandError(commandId: String, message: String, code: String?) {
        commandErrors.append((commandId, message, code))
    }
    func replyNotConfigured(commandId: String, logLabel: String) {
        commandErrors.append((commandId, "not configured", nil))
    }
    func decodeAutoTaskRequest(type: String, data: Data?) -> MobileAutoTaskRequest? { autoTaskRequest }
    func sendAutoTaskReply(_ reply: MobileAutoTaskReply) { autoTaskReplies.append(reply) }
    func decodeLoopRequest(type: String, data: Data?) -> MobileLoopRequest? { loopRequest }
    func sendLoopReply(_ reply: MobileLoopReply) { loopReplies.append(reply) }
    func requestDesktopApproval(_ request: PhoneDesktopApprovalRequest) async -> PhoneDesktopApprovalOutcome {
        approvalRequests.append(request)
        return approvalOutcomes.isEmpty ? .approved : approvalOutcomes.removeFirst()
    }

    /// The last ack the phone received, if any.
    var lastAck: (ok: Bool, message: String?, code: String?)? {
        for reply in autoTaskReplies.reversed() {
            if case .ack(let ok, let message, let code) = reply { return (ok, message, code) }
        }
        return nil
    }
}

@MainActor
enum PhoneBridgeFixtures {
    static func autoTaskService(suite: UserDefaults) -> (AutoCodeUpdateService, AutoTaskSettings, TaskLogStore) {
        let settings = AutoTaskSettings(defaults: suite)
        let logs = TaskLogStore()
        let service = AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: settings,
            registry: ProcessedActionsRegistry(
                storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json")),
            logStore: logs)
        return (service, settings, logs)
    }
}
