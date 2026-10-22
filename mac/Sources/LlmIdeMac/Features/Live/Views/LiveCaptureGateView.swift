import SwiftUI

/// Live's half of the Core `LiveCaptureGate` seam: while a capture runs (or
/// its post-stop ingest banner is still showing) this replaces the host pane
/// with the recording banner + live transcript; otherwise it shows the host's
/// own content. Installed by `FeatureCatalog.installLiveSeams`.
///
/// Moved here from Library's `MeetingDetailView`, which used to read
/// `CaptionOrchestrator` and embed `TranscriptView` directly — a Library→Live
/// edge. The UI and its state (`meetingTitleDraft`, `recordingPulse`) are
/// unchanged; only their owner moved.
struct LiveCaptureGateView: View {
    let request: LiveCaptureGateRequest
    @EnvironmentObject var capture: CaptionOrchestrator
    @EnvironmentObject var theme: ThemeStore
    @State private var meetingTitleDraft: String = ""
    @State private var recordingPulse = false

    var body: some View {
        if capture.isRunning || isPostStopBanner {
            recordingView
        } else {
            request.idle()
        }
    }

    private var isPostStopBanner: Bool {
        if case .success = capture.lastIngestStatus { return true }
        if case .failure = capture.lastIngestStatus { return true }
        if case .ingesting = capture.lastIngestStatus { return true }
        return false
    }

    private var recordingView: some View {
        VStack(spacing: 0) {
            recordingBanner
            Divider()
            TranscriptView(api: request.api)
        }
    }

    private var recordingBanner: some View {
        HStack(spacing: 12) {
            // Pulsing indicator
            ZStack {
                if capture.isRunning {
                    Circle()
                        .fill(theme.current.danger.opacity(0.3))
                        .frame(width: 20, height: 20)
                        .scaleEffect(recordingPulse ? 1.5 : 1.0)
                        .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true),
                                   value: recordingPulse)
                }
                Image(systemName: capture.isRunning ? "waveform" : "checkmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(capture.isRunning ? theme.current.danger : theme.current.accent3)
            }
            .onAppear { recordingPulse = true }
            .onDisappear { recordingPulse = false }

            if capture.isRunning {
                TextField("Meeting title…", text: $meetingTitleDraft)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 280)
                Button("Stop & Save") {
                    Task {
                        _ = await capture.stopAndIngest(api: request.api, meetingTitle: meetingTitleDraft)
                        meetingTitleDraft = ""
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
            } else if let copy = ingestStatusCopy {
                VStack(alignment: .leading, spacing: 2) {
                    Text(copy.text)
                        .font(.callout)
                        .foregroundStyle(copy.isError ? theme.current.danger : theme.current.textMuted)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }

    private var ingestStatusCopy: (text: String, isError: Bool)? {
        switch capture.lastIngestStatus {
        case .idle:     return nil
        case .ingesting: return ("Saving…", false)
        case .success(let id, let dur):
            return ("Saved · summarizing in background (\(id.suffix(6)), \(dur)s)", false)
        case .failure(let msg):
            return (msg, true)
        }
    }
}
