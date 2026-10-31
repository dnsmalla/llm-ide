import Foundation

/// A request a phone-started action makes for the person at the Mac to confirm, in a native modal.
///
/// Foundation-only Core type: the Auto Task bridge (Features/AutoTask) asks, `MobileControlManager`
/// (Features/MobileControl) shows the dialog and applies the limits, and neither names the other.
struct PhoneDesktopApprovalRequest: Equatable {
    /// Dialog title, naming the exact action ("Run Implement Issues from your iPhone?").
    let title: String
    /// One fact per line: project, branch and issue ids. Shown verbatim; the phone cannot add to it.
    let lines: [String]
}

/// What came of asking. Everything except `.approved` is a refusal.
enum PhoneDesktopApprovalOutcome: Equatable {
    case approved
    /// The person pressed Cancel (the default button).
    case denied
    /// Nobody answered within the limit; treated as a denial.
    case timedOut
    /// Another confirmation is on screen, or too many were asked for recently.
    case busy
}
