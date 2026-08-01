import SwiftUI

/// Shown in place of `LoginView` when a saved refresh token exists but the
/// launch `/auth/refresh` failed for a *transient* reason (backend
/// unreachable / timeout / 5xx). Unlike the old behaviour — which deleted the
/// saved login on any refresh failure — this keeps the token and lets the
/// user retry, and auto-retries once the backend reports `.running`. A
/// secondary "Sign out" is provided for the rare case they genuinely want to
/// switch accounts. See `SessionStore.performLaunchRefresh` and
/// `SessionStore.unreachable`.
struct ReconnectView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var config: AppConfig
    @Environment(BackendManager.self) private var backend

    let api: LlmIdeAPIClient

    var body: some View {
        ZStack {
            theme.current.body.ignoresSafeArea()
            VStack {
                Spacer(minLength: Spacing.xxl)
                card
                    .frame(maxWidth: 380)
                Spacer()
                serverPill
                    .padding(.bottom, Spacing.lg)
            }
            .frame(maxWidth: .infinity)
        }
        // When the backend transitions to .running (e.g. the auto-started
        // server just came up), retry the launch refresh automatically so the
        // user doesn't have to click Retry themselves. Fires only on a status
        // *change*, so it can't loop.
        .onChange(of: backend.status) { _, newStatus in
            guard case .running = newStatus, session.unreachable else { return }
            Task { await session.reconnect(api: api) }
        }
    }

    // MARK: - Card

    @ViewBuilder
    private var card: some View {
        VStack(spacing: Spacing.lg) {
            VStack(spacing: Spacing.sm) {
                ZStack {
                    RoundedRectangle(cornerRadius: Radius.md)
                        .fill(theme.current.accent.opacity(theme.current.isDark ? 0.20 : 0.12))
                        .frame(width: 56, height: 56)
                    Image(systemName: "wifi.slash")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(theme.current.accent)
                }
                Text("Can’t reach the server")
                    .font(Typography.display)
                    .foregroundStyle(theme.current.text)
                Text("The LLM-IDE server isn’t responding. You’re still signed in — start the server or retry.")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            statusRow
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: Spacing.sm) {
                Button {
                    Task { await session.reconnect(api: api) }
                } label: {
                    HStack {
                        if session.bootstrapping { ProgressView().controlSize(.small) }
                        Text(session.bootstrapping ? "Connecting…" : "Retry")
                            .font(Typography.bodyStrong)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.xs)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(session.bootstrapping)
                .keyboardShortcut(.defaultAction)

                Button("Sign out", role: .destructive) {
                    session.clear()
                }
                .font(Typography.caption)
                .buttonStyle(.plain)
            }
        }
        .padding(Spacing.xl)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Radius.lg)
                .fill(theme.current.surface)
                .shadow(color: Color.black.opacity(theme.current.isDark ? 0.45 : 0.10),
                        radius: 18, y: 6)
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.lg)
                        .strokeBorder(theme.current.border, lineWidth: 0.5)
                )
        )
    }

    // MARK: - Status row

    /// Adaptive backend status, mirroring `LoginView.startServerRow`:
    /// `.starting` → spinner; `.running` → checkmark (auto-retrying);
    /// configured → a "Start Server" button; unconfigured → setup hint.
    @ViewBuilder
    private var statusRow: some View {
        if case .starting = backend.status {
            HStack(spacing: Spacing.xs) {
                ProgressView().controlSize(.mini)
                Text("Starting server…")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
        } else if case .running = backend.status {
            HStack(spacing: Spacing.xs) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.accent3)
                Text("Server is running — retrying…")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
        } else if !config.backendNodePath.isEmpty && !config.backendWorkingDir.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Button(action: startServer) {
                    HStack(spacing: 4) {
                        Image(systemName: "play.fill").font(.system(size: 10))
                        Text("Start Server")
                    }
                    .font(Typography.caption)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .tint(theme.current.accent)
                if let startErr = backend.lastError {
                    Text(startErr)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else {
            HStack(spacing: Spacing.xs) {
                Image(systemName: "gearshape")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
                Text("Configure the backend path in Settings → Backend first.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var serverPill: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: "server.rack")
                .font(.system(size: 10))
            Text(config.serverURL)
                .font(Typography.mono)
        }
        .foregroundStyle(theme.current.textMuted)
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 6)
        .background(theme.current.surface2.opacity(0.7))
        .clipShape(Capsule())
    }

    // MARK: - Actions

    /// Launch the local backend — mirrors `LoginView.startServer`, repairing
    /// stale stored paths first so the button still works if the repo moved.
    private func startServer() {
        BackendManager.resolveLaunchPaths(config: config)
        backend.start(
            nodePath: config.backendNodePath,
            workingDirectory: config.backendWorkingDir)
    }
}
