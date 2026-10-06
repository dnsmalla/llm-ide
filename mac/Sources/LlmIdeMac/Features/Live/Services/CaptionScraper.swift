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
/// of `Caption` values.  Dedup/merge policy lives in `CaptionDeltaState`:
/// unchanged lines are dropped and a growing utterance replaces its row.
///
/// Also owns the active session id (stable for one recording) and the
/// last ingest status, so the UI can render success/failure feedback
/// without an extra view-model layer.
@MainActor
final class CaptionOrchestrator: ObservableObject {
    @Published private(set) var captions: [Caption] = []
    @Published private(set) var isRunning: Bool = false
    @Published private(set) var activeSource: CaptureSource = .unknown
    /// The last platform a scraper actually read from during this recording.
    /// `activeSource` falls back to `.unknown` whenever the app is momentarily
    /// not detected, so it cannot tell us at stop time which meeting this was.
    private var observedSource: CaptureSource?
    /// See `tick()`: which scraper was available at the last re-check.
    private var cachedScraperIndex: Int?
    private var lastAvailabilityCheck: TimeInterval = -.infinity
    private static let availabilityRecheckInterval: TimeInterval = 1.0
    @Published private(set) var sessionId: String?
    @Published private(set) var startedAt: Date?
    @Published var lastIngestStatus: IngestStatus = .idle
    /// True if capture stopped because the user revoked Accessibility
    /// permission mid-session.  Views observe this to flash a banner
    /// like "Captions paused — Accessibility was revoked.  Re-grant
    /// in System Settings to resume."  Cleared on the next start().
    @Published private(set) var permissionLost: Bool = false
    /// True when recording has run for a few seconds with no caption source
    /// found (captions panel not open / not visible to AX). The transcript
    /// pane surfaces this so the user doesn't stare at a silent red indicator
    /// and a zero count with no explanation.
    @Published private(set) var noSourceDetected: Bool = false

    enum IngestStatus: Equatable {
        case idle
        case ingesting
        case success(meetingId: String, durationSec: Int)
        case failure(message: String)
    }

    private let log = Logger(subsystem: "com.llmide.macapp", category: "Capture")
    private var pollTimer: Timer?
    private var deltaState = CaptionDeltaState()
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
    /// Notes folder captured once in `start()` so a project switch
    /// mid-recording can't split finalize/cleanup across two folders.
    private var recordingRoot: URL?
    /// Rows not yet written to the partial file, keyed by delta-state row id.
    /// A row is written once it is "closed": it stopped growing for
    /// `rowCloseAfter` seconds, scrolled off screen, or capture ended — so
    /// the file doesn't get one row per growth step, yet a crash loses at
    /// most the last few seconds.
    /// `firstSeenAt` / `changedAt` are monotonic (`systemUptime`), so a wall
    /// clock jump can neither flush early nor starve a row.
    private struct PendingRow {
        let timestamp: Date
        let speaker: String
        var text: String
        let firstSeenAt: TimeInterval
        var changedAt: TimeInterval
    }
    /// File-side mirror of every row, in row order, untouched by the UI trim
    /// of `captions`.  The finish-time body rewrite is generated from this so
    /// it stays correct after trimming.
    /// NOTE: memory grows with meeting length (one small entry per
    /// utterance, roughly 100-300 bytes each), unlike `captions`, which is
    /// capped at `maxCaptionCount`.
    private struct FileRow {
        let timestamp: Date
        let speaker: String
        var text: String
    }
    private var fileRows: [Int: FileRow] = [:]
    private var pendingRows: [Int: PendingRow] = [:]
    /// Row id -> id of the `Caption` currently holding that row.
    private var rowCaptionIDs: [Int: UUID] = [:]
    private var writtenRows: Set<Int> = []
    /// True when the partial file can differ from `captions` (a written row
    /// later grew, or rows were written out of order).  Fixed up by a body
    /// rewrite at finish.
    private var fileNeedsRewrite = false
    private let rowCloseAfter: TimeInterval = 3.0
    /// A still-growing row is written anyway after this long, so a long
    /// monologue survives a crash.  Later growth sets `fileNeedsRewrite`.
    private let rowMaxPendingAge: TimeInterval = 15.0

    /// The frontmatter `platform` value for a scraper source.
    private static func platformTag(_ source: CaptureSource) -> String? {
        switch source {
        case .zoomDesktop: return "zoom"
        case .teamsDesktop: return "teams"
        case .unknown: return nil
        }
    }

    init(scrapers: [CaptionScraper] = PlatformDetector.allScrapers,
         pollInterval: TimeInterval = 0.25) {
        self.scrapers = scrapers
        self.pollInterval = pollInterval
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        permissionLost = false
        noSourceDetected = false
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
        deltaState = CaptionDeltaState()
        observedSource = nil
        cachedScraperIndex = nil
        lastAvailabilityCheck = -.infinity
        pendingRows.removeAll()
        rowCaptionIDs.removeAll()
        writtenRows.removeAll()
        fileRows.removeAll()
        fileNeedsRewrite = false
        lastIngestStatus = .idle
        lastNewCaptionAt = now
        isIdlePolling = false

        let root = NotesFolderConfig().currentFolder
        recordingRoot = root
        let store = MeetingFileStore(root: root)
        do {
            let h = try store.createPartial(
                id: id, startedAt: now,
                // The language drives the summary (`summarizeFM.language`). A
                // hardcoded "en" summarised every Japanese meeting in English;
                // use the user's preferred language, the best signal available
                // before any caption has been read.
                platform: "mic", language: AppConfig.shared.preferredLanguage)
            self.fileHandle = h
            try? PartialRecovery(notesFolder: root)
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
            flushAllPendingRows(to: h)
            try? h.flush()
            try? h.close()
            rewriteTranscriptIfNeeded(at: h.url)
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
        let capturedRoot = recordingRoot ?? NotesFolderConfig().currentFolder
        if let handle = capturedHandle {
            flushAllPendingRows(to: handle)
            try? handle.flush()
            // Before finalize: it reads the file by URL, so a body fixed up
            // here is what gets finalized (the open fd just closes).
            rewriteTranscriptIfNeeded(at: handle.url)
        }
        fileHandle = nil
        stop()  // flush the timer first so a late tick can't mutate the buffer mid-ship
        guard let id = sessionId, let startedAt else {
            lastIngestStatus = .failure(message: "No active session.")
            return nil
        }
        guard !captions.isEmpty else {
            // Nothing was captured, so the partial holds only its header.
            // Close it, delete it, and drop its recovery record — left in
            // place, the next launch offered to "recover" an empty meeting.
            if let handle = capturedHandle {
                let root = capturedRoot
                MeetingFileStore(root: root).discardPartial(handle: handle)
                try? PartialRecovery(notesFolder: root).cleanup(id: handle.id)
            }
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
            let root = capturedRoot
            let store = MeetingFileStore(root: root)
            do {
                let url = try store.finalize(
                    handle: handle,
                    title: request.title,
                    endedAt: Date(),
                    participants: participants,
                    platform: observedSource.flatMap(Self.platformTag))
                try? PartialRecovery(notesFolder: root).cleanup(id: handle.id)
                // Fire-and-forget summarize.  Failure leaves the file as-is
                // and the user can hit ⌘R Re-summarize from the detail view.
                let transcriptText = transcript
                let summarizeFM = handle.frontmatter
                let summarizeParticipants = participants
                let summarizeTitle = request.title
                Task.detached(priority: .background) { [api] in
                    // Build the .docx output path before entering the service.
                    let projectRoot = root.deletingLastPathComponent()
                    let rawFileName = url.lastPathComponent
                    let monthPath = AppDateFormatter.yearMonthPath(summarizeFM.startedAt)
                    let rawFile = "meetings/\(monthPath)/\(rawFileName)"

                    await MeetingSummarizationService.run(
                        api: api,
                        transcript: transcriptText,
                        title: summarizeTitle,
                        language: summarizeFM.language,
                        startedAt: summarizeFM.startedAt,
                        durationSeconds: summarizeFM.durationSeconds,
                        participants: summarizeParticipants,
                        transcriptFileURL: url,
                        projectRoot: projectRoot,
                        rawFile: rawFile,
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
        flushIdlePendingRows(now: ProcessInfo.processInfo.systemUptime)
        // `isAvailable()` scans NSWorkspace.runningApplications (and for some
        // platforms probes AX); doing that at 4 Hz for a whole meeting is waste.
        // Re-evaluate about once a second and reuse the answer in between.
        let nowUptime = ProcessInfo.processInfo.systemUptime
        let scraper: CaptionScraper?
        if nowUptime - lastAvailabilityCheck >= Self.availabilityRecheckInterval {
            lastAvailabilityCheck = nowUptime
            cachedScraperIndex = scrapers.firstIndex(where: { $0.isAvailable() })
        }
        scraper = cachedScraperIndex.map { scrapers[$0] }
        guard let scraper else {
            activeSource = .unknown
            // After a short grace period, flag that no caption source is
            // visible to AX (captions not enabled/open in the meeting) so the
            // transcript pane can say so instead of looking silently empty.
            if captions.isEmpty, let started = startedAt,
               Date().timeIntervalSince(started) > 8 {
                noSourceDetected = true
            }
            return
        }
        observedSource = scraper.source
        if activeSource != scraper.source {
            activeSource = scraper.source
            noSourceDetected = false
            log.info("active scraper: \(scraper.source.rawValue, privacy: .public)")
        }

        let now = Date()
        let uptime = ProcessInfo.processInfo.systemUptime
        let deltas = deltaState.ingest(scraper.snapshot())
        let sawNew = deltas.contains { delta in
            if case .closed = delta { return false }
            return true
        }
        for delta in deltas {
            apply(delta, source: scraper.source, now: now, uptime: uptime)
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
            noSourceDetected = false
            if isIdlePolling { setPollCadence(idle: false) }
        } else if !isIdlePolling, now.timeIntervalSince(lastNewCaptionAt) > idleAfter {
            setPollCadence(idle: true)
        }
    }

    private func apply(_ delta: CaptionDelta, source: CaptureSource, now: Date,
                       uptime: TimeInterval) {
        switch delta {
        case let .append(row, speaker, text):
            appendRow(row, speaker: speaker, text: text, source: source,
                      now: now, uptime: uptime)
        case let .replace(row, speaker, _, newText):
            updateFileSide(row, speaker: speaker, text: newText, now: now, uptime: uptime)
            guard let captionID = rowCaptionIDs[row],
                  let idx = captions.firstIndex(where: { $0.id == captionID }) else {
                // Row was trimmed from the UI list; keep the text visible but
                // do not re-pend it (updateFileSide already handled the file).
                let caption = Caption(speaker: speaker, text: newText,
                                      timestamp: now, source: source)
                captions.append(caption)
                rowCaptionIDs[row] = caption.id
                return
            }
            let old = captions[idx]
            // Keep the id so the list row identity (and auto-scroll) is stable.
            captions[idx] = Caption(id: old.id, speaker: speaker, text: newText,
                                    timestamp: old.timestamp, source: old.source)
        case let .closed(row):
            if let handle = fileHandle { flushRow(row, to: handle) }
            rowCaptionIDs.removeValue(forKey: row)
        }
    }

    /// Applies grown text to the file-side state for `row`: the mirror, and
    /// either the pending row or a rewrite flag when it was already written.
    private func updateFileSide(_ row: Int, speaker: String, text: String,
                                now: Date, uptime: TimeInterval) {
        if var mirrored = fileRows[row] {
            mirrored.text = text
            fileRows[row] = mirrored
        } else {
            fileRows[row] = FileRow(timestamp: now, speaker: speaker, text: text)
        }
        if var pending = pendingRows[row] {
            pending.text = text
            pending.changedAt = uptime
            pendingRows[row] = pending
        } else if writtenRows.contains(row) {
            fileNeedsRewrite = true
        } else {
            let timestamp = fileRows[row]?.timestamp ?? now
            pendingRows[row] = PendingRow(timestamp: timestamp, speaker: speaker, text: text,
                                          firstSeenAt: uptime, changedAt: uptime)
        }
    }

    private func appendRow(_ row: Int, speaker: String, text: String,
                           source: CaptureSource, now: Date, uptime: TimeInterval) {
        let caption = Caption(speaker: speaker, text: text, timestamp: now, source: source)
        captions.append(caption)
        rowCaptionIDs[row] = caption.id
        fileRows[row] = FileRow(timestamp: now, speaker: speaker, text: text)
        pendingRows[row] = PendingRow(timestamp: now, speaker: speaker, text: text,
                                      firstSeenAt: uptime, changedAt: uptime)
    }

    /// Writes one pending row (if any) to `handle`.
    private func flushRow(_ row: Int, to handle: MeetingFileStore.Handle) {
        guard let pending = pendingRows.removeValue(forKey: row) else { return }
        // An earlier row still pending means the file order will differ
        // from `captions`; the finish-time rewrite repairs it.
        if pendingRows.keys.contains(where: { $0 < row }) { fileNeedsRewrite = true }
        writtenRows.insert(row)
        try? handle.appendCaption(timestamp: pending.timestamp,
                                  speaker: pending.speaker, text: pending.text)
    }

    /// Writes every pending row once, in row order, and clears them.
    private func flushAllPendingRows(to handle: MeetingFileStore.Handle) {
        for row in pendingRows.keys.sorted() { flushRow(row, to: handle) }
    }

    /// Writes rows that stopped growing for `rowCloseAfter` seconds, or that
    /// have been pending longer than `rowMaxPendingAge` (`now` is uptime).
    private func flushIdlePendingRows(now: TimeInterval) {
        guard let handle = fileHandle else { return }
        let idle = pendingRows
            .filter {
                now - $0.value.changedAt >= rowCloseAfter
                    || now - $0.value.firstSeenAt >= rowMaxPendingAge
            }
            .keys.sorted()
        for row in idle { flushRow(row, to: handle) }
    }

    /// Regenerates the transcript body from the file-side mirror (`fileRows`,
    /// not `captions`, so UI trimming cannot lose rows) when the partial file
    /// may disagree with it.  `MeetingFileStore` has no body-rewrite API, so
    /// this keeps its line format.  Call after the handle is flushed;
    /// best-effort.
    private func rewriteTranscriptIfNeeded(at url: URL) {
        guard fileNeedsRewrite else { return }
        fileNeedsRewrite = false
        let marker = "## Transcript\n\n"
        guard let contents = try? String(contentsOf: url, encoding: .utf8),
              let range = contents.range(of: marker) else { return }
        let body = fileRows.keys.sorted().compactMap { fileRows[$0] }.map {
            "[\(AppDateFormatter.hourMinuteSecond($0.timestamp))] **\($0.speaker)**: \($0.text)\n"
        }.joined()
        let rewritten = String(contents[..<range.upperBound]) + body
        do {
            try Data(rewritten.utf8).write(to: url, options: .atomic)
        } catch {
            log.error("transcript rewrite failed: \(error.localizedDescription, privacy: .public)")
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

extension Caption {
    /// Rebuilds a caption with an explicit id (a growing line keeps its
    /// identity so list scrolling follows it).
    init(id: UUID, speaker: String, text: String, timestamp: Date, source: CaptureSource) {
        self.id = id
        self.speaker = speaker
        self.text = text
        self.timestamp = timestamp
        self.source = source
    }
}
