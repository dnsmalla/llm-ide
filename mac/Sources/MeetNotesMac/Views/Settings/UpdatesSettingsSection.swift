// Settings → Updates. Exposes the two user-facing controls:
//
//   - Automatic background checks (toggle, persisted by Sparkle in
//     UserDefaults as SUEnableAutomaticChecks).
//   - Manual "Check now" button. Same primitive as the menu bar's
//     "Check for Updates…" item — most users hit one or the other,
//     but discoverability is better with both visible.
//
// The bundle version is also shown so a user filing a bug knows what
// build they're on without rooting around in the About box.

import SwiftUI

struct UpdatesSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var updateService: UpdateService

    var body: some View {
        SettingsSectionCard(icon: "arrow.down.circle", title: "Updates") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Meet Notes checks for new versions in the background. Turn this off to opt out — you'll still be able to run a manual check.")

                versionRow

                Divider().opacity(0.4)

                Toggle(isOn: Binding(
                    get: { updateService.automaticChecksEnabled },
                    set: { updateService.automaticChecksEnabled = $0 }
                )) {
                    Text("Check for updates automatically")
                }
                .toggleStyle(.switch)
                .controlSize(.small)

                HStack {
                    Spacer()
                    Button {
                        updateService.checkForUpdates()
                    } label: {
                        Label("Check now", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(!updateService.canCheckForUpdates)
                }
            }
        }
    }

    private var versionRow: some View {
        let t = theme.current
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return HStack {
            Text("Installed version")
                .font(Typography.body)
                .foregroundStyle(t.text)
            Spacer()
            Text("\(v) (\(build))")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(t.textMuted)
                .textSelection(.enabled)
        }
    }
}
