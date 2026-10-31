import AppKit
import Foundation

/// Confirms, on the Mac, an action a phone asked for that writes code or leaves the machine.
///
/// A native modal names the exact action; **Cancel is the default button** (Return cancels), nobody
/// answering for `timeout` counts as a denial, only one dialog is ever on screen, and at most
/// `maxPerWindow` are shown per `window` so a phone cannot spam the desktop with prompts. The text
/// shown is built on the Mac from its own state: the phone supplies nothing but "run this task".
@MainActor
final class PhoneDesktopApprovalGate {
    /// `true` Allow, `false` Cancel, `nil` nobody answered in time.
    typealias Presenter = @MainActor (PhoneDesktopApprovalRequest, TimeInterval) async -> Bool?

    static let timeout: TimeInterval = 120
    static let maxPerWindow = 3
    static let window: TimeInterval = 300

    var presenter: Presenter
    private let now: () -> Date
    private let timeout: TimeInterval
    private var active = false
    private var recent: [Date] = []

    init(timeout: TimeInterval = PhoneDesktopApprovalGate.timeout,
         now: @escaping () -> Date = Date.init,
         presenter: Presenter? = nil) {
        self.timeout = timeout
        self.now = now
        self.presenter = presenter ?? { request, timeout in Self.presentAlert(request, timeout: timeout) }
    }

    var isShowing: Bool { active }

    func request(_ request: PhoneDesktopApprovalRequest) async -> PhoneDesktopApprovalOutcome {
        guard !active else { return .busy }
        let t = now()
        recent.removeAll { t.timeIntervalSince($0) >= Self.window }
        guard recent.count < Self.maxPerWindow else { return .busy }
        recent.append(t)
        active = true
        defer { active = false }
        switch await presenter(request, timeout) {
        case .some(true):  return .approved
        case .some(false): return .denied
        case .none:        return .timedOut
        }
    }

    /// The real dialog. `runModal` is app-modal and blocks this call, so the timeout is a timer in the
    /// `.common` modes (which include the modal-panel mode) that aborts the modal.
    private static func presentAlert(_ request: PhoneDesktopApprovalRequest, timeout: TimeInterval) -> Bool? {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = request.title
        alert.informativeText = request.lines.joined(separator: "\n")
            + "\n\nRequested from your paired iPhone. Cancel if you did not just ask for this."
        let cancel = alert.addButton(withTitle: "Cancel")      // first button = default (Return)
        let allow = alert.addButton(withTitle: "Allow once")
        cancel.keyEquivalent = "\r"
        allow.keyEquivalent = ""
        var timedOut = false
        let timer = Timer(timeInterval: timeout, repeats: false) { _ in
            timedOut = true
            NSApp.abortModal()
        }
        RunLoop.main.add(timer, forMode: .common)
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        timer.invalidate()
        if timedOut { return nil }
        return response == .alertSecondButtonReturn
    }
}
