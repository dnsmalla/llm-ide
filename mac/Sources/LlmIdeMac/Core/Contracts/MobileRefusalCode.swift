import Foundation

/// Machine-readable reasons the Mac gives a phone when it refuses a request.
///
/// Raw strings on the wire (`CommandError.code`, `AutoTaskAck.code`): an older phone ignores a code it has
/// never heard of and still shows the human `message`; an older Mac never sends one. Lives in Core because
/// the feature-side bridges (Auto Task, Loop) that refuse requests cannot name `SharedProtocol`.
enum MobileRefusalCode {
    /// The task's own enable flag is off on the Mac; a phone run no longer overrides it.
    static let taskDisabled = "task_disabled"
    /// The action is desktop-only (templates, per-task config, toggles, always-allow rules, Bypass).
    static let desktopOnly = "desktop_only"
    /// Waiting for the person at the Mac to confirm. Not a failure: a result follows.
    static let awaitingDesktopApproval = "awaiting_desktop_approval"
    /// The person at the Mac pressed Cancel.
    static let desktopDenied = "desktop_denied"
    /// Nobody answered the Mac's confirmation within the time limit; treated as a denial.
    static let desktopApprovalTimeout = "desktop_approval_timeout"
    /// Another confirmation is already on screen, or too many were requested recently.
    static let desktopApprovalBusy = "desktop_approval_busy"
    /// The message type is not in the Mac's tier table (unknown or from a newer phone): refused unseen.
    static let unknownType = "unknown_type"
    /// The message type is known but this phone may not send it (tier D, or its switch is off).
    static let tierRefused = "tier_refused"
}
