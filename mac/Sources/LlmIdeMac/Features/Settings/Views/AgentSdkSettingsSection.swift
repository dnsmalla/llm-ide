import SwiftUI

/// Settings → Claude Agent SDK: the backend's SDK version against the npm
/// registry's latest, and a one-click update.
///
/// The chat engine runs on the Claude Agent SDK, which ships often and bundles
/// its own Claude Code binary. "Update" asks the backend to install the latest
/// release in its checkout (`POST /kb/agent-sdk/update` — smoke-checked, and
/// rolled back if the new version does not load), then restarts the backend
/// so the new version is the one running.
struct AgentSdkSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(BackendManager.self) private var backend

    @State private var status: AgentSdkStatus?
    @State private var loadError: String?
    @State private var checking = false
    @State private var updating = false
    @State private var resultMessage: String?
    @State private var resultIsError = false
    @State private var resultLog: String?

    var body: some View {
        SettingsSectionCard(icon: "shippingbox", title: "Claude Agent SDK") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("The chat engine runs on Anthropic's Claude Agent SDK. Updating installs the newest release in the backend's folder and restarts the backend; a release that fails to load is rolled back.")

                versionRow("Running", status?.running)
                if let s = status, s.restartNeeded {
                    versionRow("Installed", s.installed)
                }
                versionRow("Latest", status?.latest)

                if let loadError {
                    Text(loadError)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                } else if let err = status?.error {
                    Text("Couldn't check for updates: \(err)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.warning)
                }
                if let s = status, !s.canUpdate {
                    Text("Updates are disabled while the backend accepts remote connections.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
                if let resultMessage {
                    Text(resultMessage)
                        .font(Typography.caption)
                        .foregroundStyle(resultIsError ? theme.current.danger : theme.current.success)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let resultLog, resultIsError, !resultLog.isEmpty {
                    ScrollView {
                        Text(resultLog)
                            .font(Typography.mono)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 120)
                }

                HStack(spacing: Spacing.sm) {
                    if updating {
                        ProgressView().controlSize(.small)
                        Text("Updating — downloading can take a few minutes…")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Button {
                        Task { await refresh(force: true) }
                    } label: {
                        Label("Check now", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(checking || updating)

                    if let s = status, s.restartNeeded, !updating {
                        Button("Restart backend") { restartBackend() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    if let s = status, s.updateAvailable, let latest = s.latest {
                        Button("Update to \(latest)") { Task { await update() } }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(updating || s.updating || !s.canUpdate)
                    }
                }
            }
        }
        .task { await refresh(force: false) }
    }

    private func versionRow(_ label: String, _ value: String?) -> some View {
        HStack {
            Text(label)
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
            Spacer()
            Text(value ?? "—")
                .font(Typography.mono)
                .textSelection(.enabled)
        }
    }

    private func refresh(force: Bool) async {
        checking = true
        defer { checking = false }
        do {
            status = try await api.agentSdkStatus(force: force)
            loadError = nil
        } catch {
            // An older backend (server API < 57) has no such route.
            loadError = "The backend didn't report its SDK version (\(error.localizedDescription)). Restart it if it predates this app."
        }
    }

    private func update() async {
        updating = true
        resultMessage = nil
        resultLog = nil
        defer { updating = false }
        do {
            let r = try await api.updateAgentSdk()
            resultLog = r.log
            if r.ok && r.restartNeeded {
                resultIsError = false
                resultMessage = "Installed \(r.to ?? "the latest version"). Restarting the backend…"
                restartBackend()
                await waitForBackend()
                await refresh(force: false)
                resultMessage = status?.running == r.to
                    ? "Updated to \(r.to ?? "") — the backend is running it."
                    : "Installed \(r.to ?? ""). Restart the backend to start using it."
            } else if r.ok {
                resultIsError = false
                resultMessage = r.log ?? "Already up to date."
                await refresh(force: false)
            } else {
                resultIsError = true
                resultMessage = r.rolledBack
                    ? "The update failed and \(r.from ?? "the previous version") was restored."
                    : "The update failed."
                await refresh(force: false)
            }
        } catch {
            resultIsError = true
            resultMessage = "The update request failed: \(error.localizedDescription)"
        }
    }

    private func restartBackend() {
        backend.restart(nodePath: config.backendNodePath, workingDirectory: config.backendWorkingDir)
    }

    /// Up to ~30 s for the restarted backend to answer again.
    private func waitForBackend() async {
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        for _ in 0..<30 {
            if (try? await api.agentSdkStatus()) != nil { return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }
}
