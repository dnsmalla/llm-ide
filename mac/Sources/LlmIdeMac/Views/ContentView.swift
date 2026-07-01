import SwiftUI

/// Top-level shell.  Hosts the file-based `AppShell` once the user is
/// signed in; shows `LoginView` otherwise.
struct ContentView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var deepLink: DeepLinkRouter
    @Environment(\.openWindow) private var openWindow

    let api: LlmIdeAPIClient

    var body: some View {
        ZStack {
            theme.current.body.ignoresSafeArea()
            if session.bootstrapping {
                ProgressView("Connecting…")
                    .foregroundStyle(theme.current.text)
            } else if !session.isAuthenticated {
                LoginView(api: api)
            } else {
                AppShell(api: api)
            }
        }
        // Drive the system chrome (titlebar, sidebar material, .bar
        // backgrounds, NSAlerts) from the same isDark flag the custom
        // palette uses.  Without this the sidebar and toolbar render in
        // the system appearance while the body uses the app palette,
        // producing the half-light/half-dark look the screenshot showed.
        .preferredColorScheme(theme.current.isDark ? .dark : .light)
        .onAppear {
            deepLink.openMainWindow = { openWindow(id: "main") }
        }
    }
}
