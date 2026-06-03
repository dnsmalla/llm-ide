import SwiftUI

struct AccountSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var config: AppConfig

    @State private var showingSignOutConfirm: Bool = false

    var body: some View {
        SettingsSectionCard(icon: "person.crop.circle", title: "Account") {
            if let user = session.user {
                HStack(spacing: Spacing.md) {
                    Text(initials(of: user.displayName))
                        .font(Typography.title)
                        .foregroundStyle(theme.current.accent)
                        .frame(width: 44, height: 44)
                        .background(theme.current.accent.opacity(theme.current.isDark ? 0.20 : 0.12))
                        .clipShape(Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(user.displayName)
                                .font(Typography.bodyStrong)
                                .foregroundStyle(theme.current.text)
                            if user.role == "admin" {
                                Text("ADMIN")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(theme.current.accent4)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(theme.current.accent4.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                        }
                        Text(user.email)
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Button("Sign out", role: .destructive) {
                        showingSignOutConfirm = true
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .confirmationDialog(
                        "Sign out of Meet Notes?",
                        isPresented: $showingSignOutConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Sign out", role: .destructive) {
                            Task { @MainActor in
                                // Clear server session first so the
                                // refresh-token Keychain item is removed
                                // via SessionStore's own bookkeeping…
                                session.clear()
                                // …then wipe every other Keychain entry
                                // this app owns (GitLab PAT, etc.) plus
                                // the saved-projects list and any cached
                                // chat history persisted to disk.
                                KeychainStore.logout()
                                config.gitLabToken = ""
                                ChatSessionStore.clear()
                                // Reset the active-session pointer so
                                // the next sign-in starts fresh.
                                UserDefaults.standard.removeObject(
                                    forKey: "MEETNOTES_CURRENT_CHAT_SESSION_ID")
                            }
                        }
                        Button("Cancel", role: .cancel) { }
                    } message: {
                        Text("This will clear your saved tokens (including your GitLab Personal Access Token) and your saved GitLab projects from this Mac.")
                    }
                }
            } else {
                Text("Not signed in.").foregroundStyle(theme.current.textMuted)
            }
        }
    }

    private func initials(of name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let chars = parts.compactMap { $0.first?.uppercased() }
        return chars.isEmpty ? "?" : chars.joined()
    }
}
