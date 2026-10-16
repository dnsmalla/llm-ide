import AppKit
import os.log

/// Automatically starts / stops the `CaptionOrchestrator` around an actual
/// meeting — but only when the user has enabled `autoCaptureOnMeeting`.
///
/// A meeting app being frontmost is NOT a meeting: Zoom/Teams sit open all
/// day, and starting on activation used to produce one "meeting" spanning
/// hours.  The signal is the scraper's caption UI (`isMeetingUIPresent()`),
/// probed every `presencePollInterval` while a meeting app is running;
/// activation only triggers an immediate probe.  Capture this service
/// started stops once that UI has been gone for `MeetingPresenceTracker`'s
/// grace period, or when the last meeting app quits.
@MainActor
final class AutoCaptureService {
    private let capture: CaptionOrchestrator
    private let config: AppConfig
    private var observers: [NSObjectProtocol] = []
    private let log = Logger(subsystem: "com.llmide.macapp", category: "AutoCapture")

    // Bundle IDs that trigger auto-start when they become frontmost.
    private let meetingBundleIDs: Set<String>

    /// Needed to ingest an auto-captured meeting. Nil (tests) means stop only.
    private let api: LlmIdeAPIClient?
    private let isAuthenticated: () -> Bool
    private var isStoppingForTermination = false
    private let scrapers: [CaptionScraper]
    private var presence = MeetingPresenceTracker()
    private var presenceTimer: Timer?
    private var presenceProbeInFlight = false
    private let presencePollInterval: TimeInterval = 3.0

    /// What to do when the last meeting app quits.
    enum TerminationAction: Equatable {
        /// Close the partial file and leave it for next-launch recovery.
        case stopOnly
        /// Same path as manual Stop: finalize the file and POST /kb/ingest.
        case stopAndIngest
    }

    /// Ingest needs an API client and a logged-in session (as manual Stop
    /// does); otherwise the partial stays on disk for the recovery prompt.
    /// Empty sessions are handled inside `stopAndIngest` (it discards them).
    nonisolated static func terminationAction(hasAPI: Bool, isAuthenticated: Bool) -> TerminationAction {
        (hasAPI && isAuthenticated) ? .stopAndIngest : .stopOnly
    }

    init(capture: CaptionOrchestrator,
         config: AppConfig,
         api: LlmIdeAPIClient? = nil,
         isAuthenticated: @escaping () -> Bool = { false },
         scrapers: [CaptionScraper] = PlatformDetector.allScrapers) {
        self.capture = capture
        self.config = config
        self.api = api
        self.isAuthenticated = isAuthenticated
        self.meetingBundleIDs = Set(scrapers.map(\.bundleID))
        self.scrapers = scrapers
    }

    func start() {
        // Idempotent like every FeatureService: a second start() must not
        // register a duplicate observer pair.
        guard observers.isEmpty else { return }

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
        let timer = Timer(timeInterval: presencePollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.probePresence() }
        }
        RunLoop.main.add(timer, forMode: .common)
        presenceTimer = timer
        log.info("auto_capture_service_started")
    }

    func stop() {
        let nc = NSWorkspace.shared.notificationCenter
        observers.forEach { nc.removeObserver($0) }
        observers.removeAll()
        presenceTimer?.invalidate()
        presenceTimer = nil
    }

    // MARK: - Private

    private func handleActivation(_ note: Notification) {
        let bundleID = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier ?? ""
        guard meetingBundleIDs.contains(bundleID) else { return }
        // Activation is only a hint to look now rather than at the next
        // timer tick; whether to record is the presence probe's call.
        probePresence()
    }

    /// Checks the caption UI off the main actor (AX is IPC into the meeting
    /// app and may stall) and feeds the answer to the tracker on main.
    private func probePresence() {
        guard config.autoCaptureOnMeeting, AXCaptionReader.canRead,
              !presenceProbeInFlight, !isStoppingForTermination else { return }
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        let candidates = scrapers.filter { running.contains($0.bundleID) }
        guard !candidates.isEmpty else { return }
        presenceProbeInFlight = true
        Task.detached(priority: .utility) { [weak self, candidates] in
            let present = candidates.contains { $0.isMeetingUIPresent() }
            await self?.applyPresence(present)
        }
    }

    private func applyPresence(_ present: Bool) {
        presenceProbeInFlight = false
        // The setting may have been switched off while the probe ran.
        guard config.autoCaptureOnMeeting else { return }
        let action = presence.observe(present: present,
                                      now: ProcessInfo.processInfo.systemUptime,
                                      isCapturing: capture.isRunning)
        switch action {
        case .none:
            break
        case .start:
            log.info("auto_capture_start meeting_ui_present")
            capture.start()
        case .stop:
            log.info("auto_capture_stop meeting_ui_gone")
            stopCapture()
        }
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
        presence.reset()
        stopCapture()
    }

    /// Same stop path for "meeting UI gone" and "last meeting app quit".
    private func stopCapture() {
        switch Self.terminationAction(hasAPI: api != nil, isAuthenticated: isAuthenticated()) {
        case .stopOnly:
            capture.stop()
        case .stopAndIngest:
            guard let api, !isStoppingForTermination else { return }
            isStoppingForTermination = true
            // stopAndIngest reports failure via lastIngestStatus and never
            // deletes a non-empty partial, so recovery still works.
            Task { @MainActor [capture, weak self] in
                let id = await capture.stopAndIngest(api: api, meetingTitle: "")
                if id == nil {
                    self?.log.error("auto_capture_ingest_skipped_or_failed")
                }
                self?.isStoppingForTermination = false
            }
        }
    }
}

/// Pure start/stop policy for auto-capture, driven by periodic "is the
/// meeting's caption UI on screen" probes.  Times are `systemUptime`.
///
/// - Present and not capturing -> `.start` (unless suppressed, below).
/// - Capture it started stops only after the UI has been absent for
///   `absenceGrace` (captions panel flicker / a brief close must not split
///   the meeting).  A capture the user started by hand is never stopped.
/// - If a capture it started stops by other means (user pressed Stop,
///   permission lost) while the meeting is still on screen, it does not
///   restart until the UI has been gone for the grace period — otherwise
///   the next probe would immediately restart what the user just stopped.
struct MeetingPresenceTracker {
    enum Action: Equatable {
        case none
        case start
        case stop
    }

    var absenceGrace: TimeInterval = 90

    private(set) var lastSeenPresentAt: TimeInterval?
    private(set) var ownsCapture = false
    private(set) var isSuppressed = false
    private(set) var wasCapturing = false
    /// Set when this tracker asked for `.stop`, so the capture ending next is
    /// ours and not a user Stop (which would suppress the next meeting).
    private(set) var expectingOwnStop = false

    /// Postcondition: returns `.start` / `.stop` at most once per transition;
    /// after `.start` the tracker considers the capture its own.
    mutating func observe(present: Bool, now: TimeInterval, isCapturing: Bool) -> Action {
        defer { wasCapturing = isCapturing }
        if expectingOwnStop && !isCapturing {
            expectingOwnStop = false
        } else if (ownsCapture || wasCapturing) && !isCapturing {
            // Stopped by the user — whoever started it. Checking only the
            // captures this tracker owned restarted a capture the user had
            // started by hand and then stopped, against their wish.
            ownsCapture = false
            isSuppressed = true
        }
        if present {
            lastSeenPresentAt = now
            guard !isCapturing, !isSuppressed else { return .none }
            ownsCapture = true
            return .start
        }
        guard let lastSeen = lastSeenPresentAt, now - lastSeen >= absenceGrace else {
            return .none
        }
        // The meeting is over: forget it, whatever happens to the capture.
        lastSeenPresentAt = nil
        isSuppressed = false
        guard ownsCapture, isCapturing else { return .none }
        ownsCapture = false
        expectingOwnStop = true
        return .stop
    }

    /// Forget all state (e.g. the meeting app quit and capture was stopped).
    mutating func reset() {
        lastSeenPresentAt = nil
        ownsCapture = false
        isSuppressed = false
        wasCapturing = false
        expectingOwnStop = false
    }
}
