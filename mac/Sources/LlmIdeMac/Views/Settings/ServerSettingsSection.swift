import SwiftUI

struct ServerSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var session: SessionStore

    @State private var serverDraft: String = ""
    @State private var serverError: String?

    private var isInsecureRemote: Bool {
        let url = serverDraft.lowercased()
        return url.hasPrefix("http://") &&
               !url.contains("localhost") &&
               !url.contains("127.0.0.1")
    }

    var body: some View {
        SettingsSectionCard(icon: "server.rack", title: "Server") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.sm) {
                    TextField("http://127.0.0.1:3456", text: $serverDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(Typography.mono)
                        .disableAutocorrection(true)
                    Button("Save") { saveServer() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(serverDraft.isEmpty || serverDraft == config.serverURL)
                }
                if let err = serverError {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                        Text(err).font(Typography.caption)
                    }
                    .foregroundStyle(theme.current.danger)
                }
                if isInsecureRemote {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                        Text("Unencrypted connection — tokens sent in plaintext.")
                            .font(Typography.caption)
                    }
                    .foregroundStyle(theme.current.warning)
                }
                SettingsHint("Changing the server signs you out. Sign in again to link your account.")
            }
        }
        .onAppear { serverDraft = config.serverURL }
    }

    private func saveServer() {
        let trimmed = serverDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard AppConfig.isSafeServerURL(trimmed) else {
            serverError = "Server URL must be http(s) with a host."
            return
        }
        config.serverURL = trimmed
        serverError = nil
        Task { @MainActor in session.clear() }
    }
}
