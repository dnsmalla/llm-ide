import SwiftUI

/// Meeting-capture control, moved here from the top header so the activity
/// bar stays navigation-only. Start/stop recording (also bound to ⌘N).
struct RecordingSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var capture: CaptionOrchestrator

    var body: some View {
        SettingsSectionCard(icon: "record.circle", title: "Recording") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                if capture.isRunning {
                    Button {
                        Task { _ = await capture.stopAndIngest(api: api, meetingTitle: "") }
                    } label: {
                        Label("Stop & Save", systemImage: "stop.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.current.danger)
                    .controlSize(.large)
                } else {
                    Button {
                        capture.start()
                    } label: {
                        Label("Start Recording", systemImage: "record.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(!AXCaptionReader.canRead)
                }
                if AXCaptionReader.canRead {
                    SettingsHint("Capture a meeting's live captions. You can also press ⌘N anywhere.")
                } else {
                    SettingsHint("Accessibility / screen-recording permission is required — grant it from the account menu → Permissions, then return here.")
                }
            }
        }
    }
}
