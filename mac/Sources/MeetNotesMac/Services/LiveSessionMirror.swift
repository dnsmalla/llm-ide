import Foundation
import Combine
import os.log

/// Polls the backend for live caption streams produced by other
/// clients (chiefly: the Chrome extension capturing from Meet/Teams/
/// Zoom web).  Surfaces the most-recent active session as
/// `@Published captions`, which TranscriptView merges into its
/// display alongside locally-captured (AX-scraped) captions.
///
/// Polling cadence:
///   - "is there an active session" → every 5 s while running
///   - "any new captions in that session" → every 1.5 s while
///     subscribed; switches to 5 s when the session reports finalized
///
/// In-memory state only — captions stay in the @Published list while
/// the Mac app is open and subscribed; the canonical record is the
/// persisted meeting that the originating client publishes via
/// /kb/ingest on Stop & Save.
@MainActor
final class LiveSessionMirror: ObservableObject {
    @Published private(set) var captions: [MirroredCaption] = []
    @Published private(set) var activeSession: MeetNotesAPIClient.LiveSessionInfo?
    @Published private(set) var isPolling: Bool = false
    @Published private(set) var lastError: String?

    struct MirroredCaption: Identifiable, Equatable {
        let id: Int                   // server seq number
        let speaker: String
        let text: String
        let timestamp: Date
        let source: String
        let meta: MeetNotesAPIClient.LiveCaptionMeta?
    }

    /// Payload posted with `.liveSessionFinalized`.
    struct FinalizedPayload {
        let sessionId: String
        let meetingTitle: String
        let startedAt: Date?
        /// All mirrored captions in chronological order — used by
        /// AppShell to write the note file via appendCaption().
        let captions: [MirroredCaption]
        /// Plain-text transcript lines ("HH:MM:SS Speaker: text"),
        /// pre-built for the /kb/summarize API call.
        let transcript: String
        /// Unique speaker names in first-seen order.
        let participants: [String]
    }

    private let log = Logger(subsystem: "com.meetnotes.macapp", category: "LiveMirror")
    private let api: MeetNotesAPIClient
    private var sessionDiscoveryTask: Task<Void, Never>?
    private var captionPollTask: Task<Void, Never>?
    private var sinceSeq: Int = 0
    /// Tracks which session IDs have already fired `.liveSessionFinalized`
    /// so a slow-poll tick after finalize doesn't fire twice.
    private var notifiedFinalizedSessions: Set<String> = []

    private let discoveryIntervalNs: UInt64 = 5_000_000_000          // 5 s
    private let captionIntervalNs:   UInt64 = 1_500_000_000          // 1.5 s
    private let finalizedSlowdownNs: UInt64 = 5_000_000_000          // 5 s after finalize
    private let maxCaptionCount = 10_000

    init(api: MeetNotesAPIClient) { self.api = api }

    func start() {
        guard !isPolling else { return }
        isPolling = true
        startDiscovery()
        log.info("live mirror polling started")
    }

    func stop() {
        sessionDiscoveryTask?.cancel(); sessionDiscoveryTask = nil
        captionPollTask?.cancel(); captionPollTask = nil
        isPolling = false
        activeSession = nil
        log.info("live mirror polling stopped")
    }

    func clear() {
        captions.removeAll()
        sinceSeq = 0
        notifiedFinalizedSessions.removeAll()
    }

    // --- Internals ---------------------------------------------------

    private func startDiscovery() {
        sessionDiscoveryTask?.cancel()
        sessionDiscoveryTask = Task { [weak self] in
            while let self, !Task.isCancelled, self.isPolling {
                await self.discoverSessions()
                try? await Task.sleep(nanoseconds: self.discoveryIntervalNs)
            }
        }
    }

    private func discoverSessions() async {
        do {
            let sessions = try await api.listLiveSessions()
            // Pick the most recently active one — list is already
            // sorted by lastWrite desc on the server side.
            if let top = sessions.first {
                if activeSession?.sessionId != top.sessionId {
                    log.info("subscribing to session: \(top.sessionId, privacy: .public)")
                    activeSession = top
                    sinceSeq = 0
                    captions.removeAll()
                    startCaptionPoll()
                }
            } else if activeSession != nil {
                // Active session went away (finalized or evicted).
                // Stop polling captions; discovery loop continues.
                log.info("no active sessions — pausing caption poll")
                captionPollTask?.cancel()
                captionPollTask = nil
                activeSession = nil
            }
        } catch {
            // Polling errors are expected (network blips, server
            // restart) — surface but don't stop the loop.
            lastError = error.localizedDescription
        }
    }

    private func startCaptionPoll() {
        captionPollTask?.cancel()
        captionPollTask = Task { [weak self] in
            while let self, !Task.isCancelled,
                  self.isPolling, self.activeSession != nil {
                let interval = await self.pollOnce()
                try? await Task.sleep(nanoseconds: interval)
            }
        }
    }

    /// Merges an incoming caption into the `captions` array without
    /// producing duplicate rows for growing utterances.
    ///
    /// The Chrome extension pushes intermediate states of a caption as its
    /// speech-recognition text grows (e.g. "Hello" → "Hello world" →
    /// "Hello world how are you").  Each intermediate state arrives as a
    /// separate server caption with a new seq number, so a naive append
    /// would render one row per state — identical except that each is a
    /// prefix of the next.
    ///
    /// Strategy: scan the tail of the caption list (up to MERGE_WINDOW
    /// entries back) for the most recent caption from the same speaker
    /// whose text is a prefix of the incoming text.  If found, replace it
    /// in-place so the display shows one cleanly growing entry instead of
    /// a staircase of duplicates.  If not found, append normally.
    ///
    /// MERGE_WINDOW is intentionally small (10) so we only collapse
    /// utterances that are genuinely contiguous.  A speaker who says the
    /// same opening phrase later in the meeting is NOT merged with the
    /// earlier utterance.
    private func mergeCaptionInPlace(_ incoming: MirroredCaption) {
        let MERGE_WINDOW = 10
        let start = max(0, captions.count - MERGE_WINDOW)
        // Walk tail backwards — the most recent same-speaker entry is
        // almost always the last one.
        for i in stride(from: captions.count - 1, through: start, by: -1) {
            let existing = captions[i]
            guard existing.speaker == incoming.speaker,
                  !existing.source.hasPrefix("agent-") else { continue }
            // Replace if: the new text starts with the old text (it grew),
            // OR both texts are identical (idempotent re-delivery).
            if incoming.text.hasPrefix(existing.text) || incoming.text == existing.text {
                captions[i] = incoming
                return
            }
            // Found the same speaker but text isn't a continuation —
            // stop searching; this is a new utterance.
            break
        }
        captions.append(incoming)
    }

    /// Returns the recommended sleep interval before the next poll.
    private func pollOnce() async -> UInt64 {
        guard let session = activeSession else { return discoveryIntervalNs }
        do {
            let r = try await api.liveCaptions(sessionId: session.sessionId, since: sinceSeq)
            if !r.captions.isEmpty {
                for c in r.captions {
                    let incoming = MirroredCaption(
                        id: c.seq,
                        speaker: c.speaker,
                        text: c.text,
                        timestamp: Date(timeIntervalSince1970: c.ts / 1000.0),
                        source: c.source,
                        meta: c.meta
                    )
                    mergeCaptionInPlace(incoming)
                }
                sinceSeq = r.sequence

                if captions.count > maxCaptionCount {
                    captions.removeFirst(min(1_000, captions.count - maxCaptionCount))
                }
            }
            // When the server marks the session finalized, fire a
            // one-shot notification so AppShell can generate the note
            // file automatically — mirrors what CaptionScraper does
            // for locally-captured (AX-scraper) sessions.
            if r.finalized,
               let sid = activeSession?.sessionId,
               !notifiedFinalizedSessions.contains(sid),
               !captions.isEmpty {
                notifiedFinalizedSessions.insert(sid)
                let sessionTitle = activeSession?.meetingTitle ?? ""
                let startedAt: Date? = activeSession.flatMap {
                    // LiveSessionInfo carries startedAt as a Unix-ms Double
                    let ms = $0.startedAt
                    return ms > 0 ? Date(timeIntervalSince1970: ms / 1000.0) : nil
                }
                // Build transcript text and participants list from the
                // in-memory captions we already mirrored.
                var seenSpeakers = [String]()
                var seenSet = Set<String>()
                var lines = [String]()
                for c in captions {
                    let t = c.timestamp
                    let hms = String(format: "%02d:%02d:%02d",
                                     Calendar.current.component(.hour, from: t),
                                     Calendar.current.component(.minute, from: t),
                                     Calendar.current.component(.second, from: t))
                    lines.append("[\(hms)] \(c.speaker): \(c.text)")
                    if !seenSet.contains(c.speaker) {
                        seenSet.insert(c.speaker)
                        seenSpeakers.append(c.speaker)
                    }
                }
                let payload = FinalizedPayload(
                    sessionId: sid,
                    meetingTitle: sessionTitle,
                    startedAt: startedAt,
                    captions: captions,
                    transcript: lines.joined(separator: "\n"),
                    participants: seenSpeakers)
                log.info("live session finalized — firing note-gen notification for \(sid, privacy: .public)")
                NotificationCenter.default.post(name: .liveSessionFinalized, object: payload)
            }

            // Slow down after finalize so we don't keep polling a
            // dead session at full rate.  Discovery loop will
            // eventually drop the active session and we'll stop.
            return r.finalized ? finalizedSlowdownNs : captionIntervalNs
        } catch {
            lastError = error.localizedDescription
            return discoveryIntervalNs
        }
    }
}
