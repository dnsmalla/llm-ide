import Foundation

/// One transcript line — produced by every caption scraper, sent to the
/// backend over /kb/ingest in the same shape the Chrome extension uses.
/// Keep field names stable: the Node side already parses this exact
/// envelope, so renaming requires migrating the extension AND the
/// server's prompt-injection wrappers in lockstep.
struct Caption: Codable, Identifiable, Equatable {
    let id: UUID
    let speaker: String
    let text: String
    let timestamp: Date
    /// Which scraper produced the line — useful for debugging "captions
    /// stopped" issues across multiple platforms in one session.
    let source: CaptureSource

    init(speaker: String, text: String, timestamp: Date = Date(), source: CaptureSource) {
        self.id = UUID()
        self.speaker = speaker
        self.text = text
        self.timestamp = timestamp
        self.source = source
    }
}

enum CaptureSource: String, Codable {
    case zoomDesktop = "zoom-desktop"
    case teamsDesktop = "teams-desktop"
    case audioFallback = "audio-fallback"
    case microphone = "microphone"
    case unknown = "unknown"
}
