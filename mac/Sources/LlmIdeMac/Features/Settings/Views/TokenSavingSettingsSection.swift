import SwiftUI

/// Settings → Token Saving: shows whether rtk is installed and installs it
/// via Homebrew on click. Turning rtk on in Claude Code stays a manual step.
struct TokenSavingSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore

    @State private var status: RtkProvisioner.Status?
    @State private var installing = false
    @State private var resultMessage: String?
    @State private var resultIsError = false

    var body: some View {
        SettingsSectionCard(icon: "leaf", title: "Token Saving") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("rtk shrinks shell command output before Claude Code reads it, cutting token use by 60–90%. It helps your own Claude Code sessions, not chats inside LLM-IDE.")

                HStack {
                    Text("rtk")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                    Text(statusText)
                        .font(Typography.mono)
                        .textSelection(.enabled)
                }

                if case .installed = status {
                    Text("To turn it on, run `rtk init -g` in Terminal and restart Claude Code. Note: rtk then lets the commands it rewrites run without asking you, including `git push`.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.warning)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if case .notInstalled(canInstall: false) = status {
                    Text("Homebrew isn't installed. Install it from brew.sh, then come back here.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let resultMessage {
                    Text(resultMessage)
                        .font(Typography.caption)
                        .foregroundStyle(resultIsError ? theme.current.danger : theme.current.success)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: Spacing.sm) {
                    if installing {
                        ProgressView().controlSize(.small)
                        Text("Installing with Homebrew — this can take a minute…")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    if case .notInstalled(canInstall: true) = status {
                        Button("Install rtk") { Task { await install() } }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(installing || RtkProvisioner.isInstalling)
                    }
                }
            }
        }
        .task { status = await RtkProvisioner.status() }
    }

    private var statusText: String {
        switch status {
        case .none: return "Checking…"
        case .installed(let version): return version
        case .notInstalled: return "Not installed"
        }
    }

    private func install() async {
        installing = true
        resultMessage = nil
        defer { installing = false }
        let result = await RtkProvisioner.install()
        resultIsError = !result.ok
        resultMessage = result.message
        status = await RtkProvisioner.status()
    }
}
