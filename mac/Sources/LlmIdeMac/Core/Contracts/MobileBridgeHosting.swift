import Foundation

/// The phone-access switches a feature-side mobile bridge re-checks on every
/// request. A Core mirror of exactly the two `PhoneAccess` cases those bridges
/// need: `PhoneAccess` lives in Features/MobileControl, and a bridge in
/// Features/AutoTask or Features/Loop must not name it.
enum MobileBridgeAccess {
    case autoTaskControl
    case loopControl
}

/// What a feature-side mobile bridge may ask of the mobile manager.
///
/// `MobileAutoTaskBridge` (Features/AutoTask) and `MobileLoopBridge`
/// (Features/Loop) serve their feature's slice of the phone protocol, but the
/// socket, the pairing state, the Phone-access switches, the log pane and the
/// wire format (`SharedProtocol`) all belong to Features/MobileControl. They
/// reach those ONLY through this protocol, which `MobileControlManager`
/// conforms to, so neither side names the other's concrete types and each
/// feature folder can be compiled out on its own.
///
/// The bridges never see a `SharedProtocol` type: `SharedProtocol` is linked
/// only when `mobile_sync` is compiled in, while the bridges compile whenever
/// `auto_tasks` is. So the host decodes inbound frames into the Foundation-only
/// request enums (`MobileAutoTaskRequest`, `MobileLoopRequest`) and encodes the
/// Foundation-only reply enums (`MobileAutoTaskReply`, `MobileLoopReply`) into
/// wire types — the mapping is type-checked on the MobileControl side, so a
/// wire-format change breaks the compile there instead of drifting silently.
///
/// Every requirement is main-actor: the manager and both bridges are.
@MainActor
protocol MobileBridgeHosting: AnyObject {
    /// App config for resolving the active project's workspace roots.
    var config: AppConfig? { get }
    /// Source of the active project.
    var projectStore: ProjectStore? { get }
    /// True while an authenticated phone is connected. Push helpers check it
    /// so a desktop-side change sends nothing when no phone is listening.
    var mobileClientPaired: Bool { get }

    /// Whether the Mac-side Phone-access switch allows `access` right now.
    /// Callers re-read it per request — a phone may hold a stale capability list.
    func isPhoneAccessAllowed(_ access: MobileBridgeAccess) -> Bool
    /// What the phone is told when a request hits `access` while it is off.
    func phoneAccessDeniedMessage(_ access: MobileBridgeAccess) -> String

    /// Redaction for free text about to leave the Mac (log lines, agent
    /// summaries). Returned as a `@Sendable` function, read on the main actor,
    /// because the bridges deliberately run it OFF the main actor — the
    /// underlying regexes are too slow for it on a long line.
    var phoneTextRedactor: @Sendable (String) -> String { get }

    /// Append an informational line to the Mobile Control log pane.
    func logInfo(_ text: String)
    /// Append an error line to the Mobile Control log pane.
    func logError(_ text: String)
    /// Log that a `type` frame did not decode. Describes the frame by type and
    /// byte size only — never its content, which can carry tokens.
    func logDecodeFailure(type: String, data: Data?)

    /// Answer the phone's pending `commandId` with an error.
    func replyCommandError(commandId: String, message: String)
    /// Same, with a machine-readable `MobileRefusalCode` the phone can branch on.
    func replyCommandError(commandId: String, message: String, code: String?)
    /// Answer `commandId` with "Auto-tasks not configured" and log it under `logLabel`.
    func replyNotConfigured(commandId: String, logLabel: String)

    /// Decode an `auto_task_*` frame. Nil when `type` is not an Auto Task
    /// message; a recognised type whose payload did not decode comes back with
    /// a nil payload, so the bridge still runs its own checks first.
    func decodeAutoTaskRequest(type: String, data: Data?) -> MobileAutoTaskRequest?
    /// Encode and send an Auto Task reply to the phone.
    func sendAutoTaskReply(_ reply: MobileAutoTaskReply)

    /// Decode a `loop_*` frame. Same nil conventions as `decodeAutoTaskRequest`.
    func decodeLoopRequest(type: String, data: Data?) -> MobileLoopRequest?
    /// Encode and send a Loop reply to the phone.
    func sendLoopReply(_ reply: MobileLoopReply)
}

extension MobileBridgeHosting {
    func replyCommandError(commandId: String, message: String) {
        replyCommandError(commandId: commandId, message: message, code: nil)
    }
}
