// Settings → Updates & About. Exposes the two user-facing controls:
//
//   - Automatic background checks (toggle, persisted by Sparkle in
//     UserDefaults as SUEnableAutomaticChecks).
//   - Manual "Check now" button. Same primitive as the menu bar's
//     "Check for Updates…" item — most users hit one or the other,
//     but discoverability is better with both visible.
//
// Absorbed the former standalone About section (version/bundle ID were
// duplicated across both — a bug report needs both together anyway).

import SwiftUI

struct UpdatesSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var updateService: UpdateService

    var body: some View {
        SettingsSectionCard(icon: "arrow.down.circle", title: "Updates & About") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if updateService.isUpdateFeedConfigured {
                    SettingsHint("LLM-IDE checks for new versions in the background. Turn this off to opt out — you'll still be able to run a manual check.")
                } else {
                    SettingsHint("This is a development build — Sparkle auto-update is disabled. Rebuild from git or install a release DMG to receive updates.")
                }

                versionRow
                bundleIdRow

                SettingsHint("Native macOS client for the LLM-IDE backend. Captions captured via Accessibility APIs from Zoom and Teams desktop apps.")

                if updateService.isUpdateFeedConfigured {
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

    // Absorbed from the former standalone About section — a bug report
    // needs the bundle ID as often as the version, so keep them together.
    private var bundleIdRow: some View {
        HStack {
            Text("Bundle ID").font(Typography.body).foregroundStyle(theme.current.textMuted)
            Spacer()
            Text(Bundle.main.bundleIdentifier ?? "?")
                .font(Typography.mono)
                .foregroundStyle(theme.current.text)
        }
    }
}
