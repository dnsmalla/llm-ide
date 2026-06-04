import AppKit
import os.log

/// Observes NSWorkspace frontmost-application changes and automatically
/// starts / stops the `CaptionOrchestrator` when a known meeting app
/// becomes (or leaves) the foreground — but only when the user has
/// enabled `autoCaptureOnMeeting` in Settings.
@MainActor
final class AutoCaptureService {
    private let capture: CaptionOrchestrator
    private let config: AppConfig
    private var observers: [NSObjectProtocol] = []
    private let log = Logger(subsystem: "com.llmide.macapp", category: "AutoCapture")

    // Bundle IDs that trigger auto-start when they become frontmost.
    private let meetingBundleIDs: Set<String>

    init(capture: CaptionOrchestrator,
         config: AppConfig,
         scrapers: [CaptionScraper] = PlatformDetector.allScrapers) {
        self.capture = capture
        self.config = config
        self.meetingBundleIDs = Set(scrapers.map(\.bundleID))
    }

    func start() {
        let nc = NSWorkspace.shared.notificationCenter

        // App activated — may need to start capture.
        let activateObs = nc.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self else { return }
            Task { @MainActor in self.handleActivation(note) }
        }

        // App terminated — may need to stop capture. We stop on TERMINATION, not
        // deactivation: a meeting app losing frontmost focus (user switches to a
        // browser/Slack mid-call) must NOT stop capture, or the meeting fragments
        // into multiple notes and captions spoken while away are lost.
        let terminateObs = nc.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self else { return }
            Task { @MainActor in self.handleTermination(note) }
        }

        observers = [activateObs, terminateObs]
        log.info("auto_capture_service_started")
    }

    func stop() {
        let nc = NSWorkspace.shared.notificationCenter
        observers.forEach { nc.removeObserver($0) }
        observers.removeAll()
    }

    // MARK: - Private

    private func handleActivation(_ note: Notification) {
        guard config.autoCaptureOnMeeting,
              !capture.isRunning,
              AXCaptionReader.canRead else { return }
        let bundleID = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier ?? ""
        guard meetingBundleIDs.contains(bundleID) else { return }
        log.info("auto_capture_start bundleID=\(bundleID, privacy: .public)")
        capture.start()
    }

    private func handleTermination(_ note: Notification) {
        guard config.autoCaptureOnMeeting, capture.isRunning else { return }
        let bundleID = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier ?? ""
        guard meetingBundleIDs.contains(bundleID) else { return }
        // Stop only when NO meeting app remains running — handles the case of
        // multiple meeting apps open, and never stops just because one lost focus.
        let stillRunning = NSWorkspace.shared.runningApplications.contains {
            guard let id = $0.bundleIdentifier else { return false }
            return meetingBundleIDs.contains(id)
        }
        guard !stillRunning else { return }
        log.info("auto_capture_stop bundleID=\(bundleID, privacy: .public)")
        capture.stop()
    }
}
