import SwiftUI

struct AboutSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        SettingsSectionCard(icon: "info.circle", title: "About") {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack {
                    Text("Version").font(Typography.body).foregroundStyle(theme.current.textMuted)
                    Spacer()
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
                        .font(Typography.mono)
                        .foregroundStyle(theme.current.text)
                }
                HStack {
                    Text("Bundle ID").font(Typography.body).foregroundStyle(theme.current.textMuted)
                    Spacer()
                    Text(Bundle.main.bundleIdentifier ?? "?")
                        .font(Typography.mono)
                        .foregroundStyle(theme.current.text)
                }
                SettingsHint("Native macOS client for the LLM IDE backend. Captions captured via Accessibility APIs from Zoom and Teams desktop apps.")
            }
        }
    }
}
