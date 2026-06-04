import Foundation
import Combine
import os.log

/// Common protocol every per-platform scraper conforms to.  Adding
/// FaceTime / Webex / Discord later is one new file that conforms,
/// plus one entry in `PlatformDetector.allScrapers`.
protocol CaptionScraper {
    /// Stable identifier — also the source tag we attach to every
    /// caption so debug output makes it clear who produced what.
    var source: CaptureSource { get }

    /// Bundle ID we read from.  Matched against running apps via
    /// `AXCaptionReader.axElement(forBundleID:)`.
    var bundleID: String { get }

    /// Cheap readiness check.  Returns true when the target app is
    /// running, accessibility is granted, and the captions panel is
    /// (or could be) findable in the AX tree.  Used by the orchestrator
    /// to pick a scraper without paying the per-poll cost.
    ///
    /// Default implementation checks `AXCaptionReader.canRead` then
    /// looks up `bundleID` in the running-app list.  Override only if
    /// a platform needs additional checks.
    func isAvailable() -> Bool

    /// Pull the latest set of caption lines.  Returning the same
    /// `(speaker, text)` more than once is allowed — the orchestrator
    /// dedupes.  Empty array means "nothing new this tick" or "the
    /// captions panel isn't open."
    func snapshot() -> [(speaker: String, text: String)]
}

extension CaptionScraper {
    func isAvailable() -> Bool {
        guard AXCaptionReader.canRead else { return false }
        return AXCaptionReader.axElement(forBundleID: bundleID) != nil
    }
}

/// Drives N scrapers on a shared poll timer and emits a deduped stream
/// of `Caption` values.  Owns the in-memory dedup window — if a
/// scraper re-emits a line we've seen in the last 2 seconds, drop it.
///
/// Also owns the active session id (stable for one recording) and the
/// last ingest status, so the UI can render success/failure feedback
/// without an extra view-model layer.
@MainActor
final class CaptionOrchestrator: ObservableObject {
    @Published private(set) var captions: [Caption] = []
    @Published private(set) var isRunning: Bool = false
    @Published private(set) var activeSource: CaptureSource = .unknown
    @Published private(set) var sessionId: String?
    @Published private(set) var startedAt: Date?
    @Published var lastIngestStatus: IngestStatus = .idle
    /// True if capture stopped because the user revoked Accessibility
    /// permission mid-session.  Views observe this to flash a banner
    /// like "Captions paused — Accessibility was revoked.  Re-grant
    /// in System Settings to resume."  Cleared on the next start().
    @Published private(set) var permissionLost: Bool = false

    enum IngestStatus: Equatable {
        case idle
        case ingesting
        case success(meetingId: String, durationSec: Int)
        case failure(message: String)
    }

    private let log = Logger(subsystem: "com.llmide.macapp", category: "Capture")
    private var pollTimer: Timer?
    private var recentKeys: [(key: String, at: Date)] = []   // time-ordered, for expiry
    private var recentKeySet: Set<String> = []                // mirror of recentKeys, for O(1) membership
    private let dedupWindow: TimeInterval = 2.0
    private let scrapers: [CaptionScraper]
    private let pollInterval: TimeInterval
    private let maxCaptionCount = 10_000

    // Adaptive poll: stay at `pollInterval` (default 250 ms) while
    // captions are arriving; back off to `idlePollInterval` once the
    // meeting has been silent for `idleAfter` seconds.  The 4 Hz ↔ 2 Hz
    // toggle cuts AX-tree reads in half during the long quiet stretches
    // typical of one-presenter calls without adding visible latency
    // — a new caption snaps us back to the fast cadence on the *next*
    // tick (i.e. within at most one idle period).
    private let idlePollInterval: TimeInterval = 0.5
    private let idleAfter: TimeInterval = 5.0
    private var lastNewCaptionAt: Date = .distantPast
    private var isIdlePolling: Bool = false

    // Write-through to the .partial.md file for the active session.
    // Held only while a recording is in flight.
    private var fileHandle: MeetingFileStore.Handle?

    init(scrapers: [CaptionScraper] = PlatformDetector.allScrapers,
         pollInterval: TimeInterval = 0.25) {
        self.scrapers = scrapers
        self.pollInterval = pollInterval
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        permissionLost = false
        // Mint a fresh session id every time recording starts.  Mirrors
        // the Chrome extension's `m-<base36-time>-<random>` shape so
        // the server treats both clients identically.
        let ts = String(Int(Date().timeIntervalSince1970), radix: 36)
        let rand = String(Int.random(in: 0..<Int(pow(36.0, 6.0))), radix: 36)
        let id = "m-\(ts)-\(rand)"
        let now = Date()
        sessionId = id
        startedAt = now
        captions.removeAll()
        recentKeys.removeAll()
        recentKeySet.removeAll()
        lastIngestStatus = .idle
        lastNewCaptionAt = now
        isIdlePolling = false

        let root = NotesFolderConfig().currentFolder
        let store = MeetingFileStore(root: root)
        do {
            let h = try store.createPartial(
                id: id, startedAt: now,
                platform: "mic", language: "en")
            self.fileHandle = h
            try? PartialRecovery(root: root)
                .record(id: id, path: h.url, startedAt: now)
        } catch {
            log.error("partial file create failed: \(error.localizedDescription, privacy: .public)")
            self.fileHandle = nil
        }

        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        log.info("capture started session=\(self.sessionId ?? "?", privacy: .public)")
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        isRunning = false
        // If a partial is still open (e.g. permission-lost path with no
        // ingest), flush and close the handle but leave the file in
        // place — recovery prompt picks it up on next launch.
        if let h = fileHandle {
            try? h.flush()
            try? h.close()
            // Keep fileHandle non-nil so finalize-on-next-stopAndIngest
            // would still find it; but here the orchestrator is done.
            fileHandle = nil
        }
        log.info("capture stopped")
    }

    /// Stop capturing AND POST the buffered captions to /kb/ingest.
    /// Failure surfaces via `lastIngestStatus` so the UI can offer a
    /// retry without re-recording.
    func stopAndIngest(api: LlmIdeAPIClient, meetingTitle: String) async -> String? {
        // Hand the open partial-file handle off to this function before
        // stop() nils it; stop() only closes the handle in the
        // permission-lost path where nothing else will finalize.
        let capturedHandle = fileHandle
        fileHandle = nil
        stop()  // flush the timer first so a late tick can't mutate the buffer mid-ship
        guard let id = sessionId, let startedAt else {
            lastIngestStatus = .failure(message: "No active session.")
            return nil
        }
        guard !captions.isEmpty else {
            lastIngestStatus = .failure(message: "Nothing to save — no captions captured.")
            return nil
        }

        lastIngestStatus = .ingesting
        let durationSec = Int(Date().timeIntervalSince(startedAt))
        let dateISO = AppDateFormatter.isoString(startedAt)
        let participants = Array(Set(captions.map(\.speaker))).sorted()
        let transcript = captions.map { "[\($0.speaker)] \($0.text)" }.joined(separator: "\n")

        let request = IngestRequest(
            id: id,
            title: meetingTitle.isEmpty ? "Untitled meeting" : meetingTitle,
            date: dateISO,
            duration: durationSec,
            language: nil,
            participants: participants,
            transcript: transcript,
            entities: []
        )

        // Finalize the on-disk partial file first.  Independent of
        // /kb/ingest so we keep the file even if the network POST fails.
        if let handle = capturedHandle {
            let root = NotesFolderConfig().currentFolder
            let store = MeetingFileStore(root: root)
            do {
                let url = try store.finalize(
                    handle: handle,
                    title: request.title,
                    endedAt: Date(),
                    participants: participants)
                try? PartialRecovery(root: root).cleanup(id: handle.id)
                // Fire-and-forget summarize.  Failure leaves the file as-is
                // and the user can hit ⌘R Re-summarize from the detail view.
                let transcriptText = transcript
                let summarizeFM = handle.frontmatter
                let summarizeParticipants = participants
                let summarizeTitle = request.title
                let sessionId = handle.id
                Task.detached(priority: .background) { [api] in
                    // Build the .docx output path before entering the service.
                    let notesDir = root.deletingLastPathComponent()
                        .appendingPathComponent("notes", isDirectory: true)
                    let dateSlug = AppDateFormatter.dateHourMinuteLocal(summarizeFM.startedAt)
                    let docxURL  = notesDir.appendingPathComponent(
                        "\(dateSlug)-\(String(sessionId.prefix(8)))-meeting-notes.docx")

                    await MeetingSummarizationService.run(
                        api: api,
                        transcript: transcriptText,
                        title: summarizeTitle,
                        language: summarizeFM.language,
                        startedAt: summarizeFM.startedAt,
                        durationSeconds: summarizeFM.durationSeconds,
                        participants: summarizeParticipants,
                        transcriptFileURL: url,
                        docxOutputURL: docxURL,
                        root: root)

                    NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
                }
            } catch {
                log.error("finalize failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        do {
            _ = try await api.ingestMeeting(request)
            lastIngestStatus = .success(meetingId: id, durationSec: durationSec)
            log.info("ingested meeting=\(id, privacy: .public) duration=\(durationSec)s lines=\(self.captions.count)")
            return id
        } catch {
            let msg = error.localizedDescription
            lastIngestStatus = .failure(message: msg)
            log.error("ingest failed: \(msg, privacy: .public)")
            return nil
        }
    }

    /// Internal tick — picks the first available scraper and pulls a
    /// snapshot.  We don't run multiple scrapers in parallel because
    /// the user is in exactly one meeting at a time; if Zoom and
    /// Teams are both open, we'd emit duplicate lines.
    private func tick() {
        guard isRunning else { return }
        // Detect mid-session Accessibility revocation.  Scrapers go
        // silent (axElement returns nil) without it, so the user would
        // otherwise watch a frozen caption count without any
        // explanation.  Stop and surface the flag so the UI can flash
        // a banner and offer "Re-grant in System Settings".
        if !AXCaptionReader.canRead {
            permissionLost = true
            log.warning("Accessibility permission lost mid-capture — stopping")
            stop()
            return
        }
        let scraper = scrapers.first(where: { $0.isAvailable() })
        guard let scraper else {
            activeSource = .unknown
            return
        }
        if activeSource != scraper.source {
            activeSource = scraper.source
            log.info("active scraper: \(scraper.source.rawValue, privacy: .public)")
        }

        let now = Date()
        // Expire old dedup entries from the front (recentKeys is time-ordered),
        // keeping recentKeySet in sync — O(expired), not an O(n) scan per tick.
        let cutoff = now.addingTimeInterval(-dedupWindow)
        while let first = recentKeys.first, first.at < cutoff {
            recentKeySet.remove(first.key)
            recentKeys.removeFirst()
        }

        var sawNew = false
        for (speaker, text) in scraper.snapshot() {
            let key = "\(speaker)::\(text)"
            if recentKeySet.contains(key) { continue }   // O(1) dedup
            recentKeys.append((key, now))
            recentKeySet.insert(key)
            captions.append(Caption(speaker: speaker, text: text, source: scraper.source))
            sawNew = true
            if let h = fileHandle {
                try? h.appendCaption(timestamp: now, speaker: speaker, text: text)
            }
        }

        if captions.count > maxCaptionCount {
            captions.removeFirst(min(1_000, captions.count - maxCaptionCount))
        }

        // Adaptive cadence: snap back to the fast interval as soon as a
        // new line lands; drop to the slow one once we've been quiet
        // for `idleAfter`.  Toggling the live Timer's interval requires
        // replacing it — Foundation.Timer's `timeInterval` is read-only
        // after scheduling.
        if sawNew {
            lastNewCaptionAt = now
            if isIdlePolling { setPollCadence(idle: false) }
        } else if !isIdlePolling, now.timeIntervalSince(lastNewCaptionAt) > idleAfter {
            setPollCadence(idle: true)
        }
    }

    private func setPollCadence(idle: Bool) {
        guard isRunning else { return }
        pollTimer?.invalidate()
        let interval = idle ? idlePollInterval : pollInterval
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        isIdlePolling = idle
    }
}
