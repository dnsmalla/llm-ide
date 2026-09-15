import Foundation

/// Captured meetings (Zoom/Teams/Meet/mic). Live capture is event-driven and
/// owned by `AutoCaptureService` + `CaptionOrchestrator`; this type only
/// supplies classification + Library SOURCES metadata, so it inherits the
/// default no-op `fetchAndIngest`.
struct MeetingSource: InputSource {
    let id = "meeting"
    let displayName = "Meetings"
    let icon = "waveform.and.mic"
    let emptyText = "No meeting files yet"
    let platforms = ["meet", "teams", "zoom", "mic"]
    let mode = SourceMode.liveCapture
}
