import SwiftUI

/// The account menu shown at the top-right of the window title bar (hosted as
/// a `.primaryAction` toolbar item). Surfaces the signed-in user plus
/// Settings, Help, Permissions, and Sign out.
struct HeaderAccountMenu: View {
    @Environment(ShellState.self) private var shell
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var theme: ThemeStore
    @State private var showingPermissions = false
    @State private var showingHelp = false
    @State private var showingSignOutConfirm = false

    var body: some View {
        Group {
            if let user = session.user {
                Menu {
                    Text(user.displayName)
                    Text(user.email).foregroundStyle(.secondary)
                    Divider()
                    Button { shell.section = .settings } label: {
                        Label("Settings…", systemImage: "gearshape")
                    }
                    .keyboardShortcut(",", modifiers: .command)
                    Button { showingHelp = true } label: {
                        Label("Help & Guide", systemImage: "questionmark.circle")
                    }
                    .keyboardShortcut("/", modifiers: .command)
                    Button { showingPermissions = true } label: {
                        Label("Permissions…", systemImage: "lock.shield")
                    }
                    Divider()
                    Button("Sign out", role: .destructive) {
                        showingSignOutConfirm = true
                    }
                } label: {
                    Image(systemName: "person.crop.circle").font(.system(size: 16))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help(user.email)
                .confirmationDialog(
                    "Sign out of LLM-IDE?",
                    isPresented: $showingSignOutConfirm,
                    titleVisibility: .visible
                ) {
                    Button("Sign out", role: .destructive) {
                        Task { @MainActor in
                            // Session + local chat history only. Git PATs and
                            // saved repos are separate connections the user
                            // set up independently; revoking them here meant
                            // signing back in landed on "No repository
                            // connected". Use the option below to drop those.
                            session.clear()
                            ChatSessionStore.clear()
                        }
                    }
                    Button("Sign out and disconnect all accounts", role: .destructive) {
                        Task { @MainActor in
                            session.clear()
                            ChatSessionStore.clear()
                            KeychainStore.wipeAllSecrets()
                        }
                    }
                    Button("Cancel", role: .cancel) { }
                } message: {
                    Text("Signing out clears your session and local chat history. Your GitHub / GitLab tokens and saved repositories stay on this Mac unless you choose to disconnect all accounts.")
                }
            }
        }
        .sheet(isPresented: $showingPermissions) {
            PermissionsView { showingPermissions = false }
                .frame(minWidth: 560, idealWidth: 600, maxWidth: 700,
                       minHeight: 520, idealHeight: 640, maxHeight: 800)
                .environmentObject(theme)
        }
        .sheet(isPresented: $showingHelp) {
            HelpGuideView { showingHelp = false }
                .environmentObject(theme)
        }
    }
}
