import SwiftUI

struct CaptureSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    var body: some View {
        SettingsSectionCard(icon: "waveform", title: "Capture") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Toggle(isOn: $config.autoCaptureOnMeeting) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Auto-capture when a meeting app is frontmost")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("Starts recording automatically once Zoom or Teams becomes the active app.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                .toggleStyle(.switch)

                Divider().background(theme.current.border)

                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Poll interval")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("\(config.pollIntervalMs) ms — how often the AX scraper reads each meeting app's caption panel.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Stepper("\(config.pollIntervalMs)",
                            value: $config.pollIntervalMs,
                            in: 100...2000, step: 50)
                        .labelsHidden()
                        .controlSize(.small)
                }
            }
        }
    }
}
