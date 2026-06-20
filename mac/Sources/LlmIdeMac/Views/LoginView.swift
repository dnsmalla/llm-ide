import SwiftUI

/// Sign-in / register screen.  Centered card with a subtle shadow,
/// SF Symbol logo, inline error rendering, and a server pill at the
/// bottom so the user can see which server they're authenticating
/// against without diving into Settings.
struct LoginView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var config: AppConfig
    @Environment(BackendManager.self) private var backend

    let api: LlmIdeAPIClient

    @State private var mode: Mode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var revealPassword = false
    @State private var busy = false
    @State private var error: String?
    @State private var serverUnreachable = false   // true iff last error was a network error
    @State private var registrationOpen = true
    @FocusState private var focused: Field?

    enum Mode { case login, register }
    enum Field { case displayName, email, password }

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
        .task { await fetchWellKnown() }
        .onAppear { focused = .email }
        // When the backend transitions to .running while a "Could not
        // reach" error is showing, automatically retry sign-in so the
        // user doesn't need to click the button a second time.
        .onChange(of: backend.status) { _, newStatus in
            guard case .running = newStatus, serverUnreachable,
                  !email.isEmpty, !password.isEmpty else { return }
            error = nil
            serverUnreachable = false
            submit()
        }
    }

    // MARK: - Card

    @ViewBuilder
    private var card: some View {
        VStack(spacing: Spacing.lg) {
            heroHeader

            VStack(spacing: Spacing.md) {
                if mode == .register {
                    field(label: "Display name", placeholder: "Optional",
                          text: $displayName, secure: false, field: .displayName)
                }
                field(label: "Email", placeholder: "you@example.com",
                      text: $email, secure: false, isEmail: true, field: .email)
                field(label: "Password",
                      placeholder: mode == .register ? "At least 10 characters" : "",
                      text: $password, secure: true, field: .password, revealable: true)

                if let error {
                    errorBanner(message: error)
                }

                Button(action: submit) {
                    HStack {
                        if busy { ProgressView().controlSize(.small) }
                        Text(busy ? "Working…"
                             : mode == .login ? "Sign in"
                             : "Create account")
                            .font(Typography.bodyStrong)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.xs)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy || email.isEmpty || password.isEmpty)
                .keyboardShortcut(.defaultAction)
                .padding(.top, Spacing.xs)

                if registrationOpen {
                    Button {
                        mode = (mode == .login) ? .register : .login
                        error = nil
                        focused = (mode == .register) ? .displayName : .email
                    } label: {
                        Text(mode == .login ? "Need an account? Register"
                                            : "Already have an account? Sign in")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.accent2)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                } else if mode == .register {
                    Text("Registration is closed on this server. Ask your admin for an account.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
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

    // MARK: - Error banner

    /// Renders the inline error block.  When the last error was a
    /// network-reachability failure (server not running), a "Start Server"
    /// button is appended so the user can launch the backend without
    /// leaving the login screen.
    @ViewBuilder
    private func errorBanner(message: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .top, spacing: Spacing.xs) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.danger)
                Text(message)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if serverUnreachable {
                startServerRow
            }
        }
        .padding(Spacing.sm)
        .background(theme.current.danger.opacity(theme.current.isDark ? 0.12 : 0.08))
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }

    /// A "Start Server" / status row shown inside the error banner when
    /// the server is unreachable.  Uses if/else rather than switch so
    /// the ViewBuilder can resolve each branch unambiguously.
    @ViewBuilder
    private var startServerRow: some View {
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
                Text("Server is running — try signing in.")
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
                // A failed start previously only logged to Settings →
                // Backend — from this screen the click looked like a
                // silent no-op. Show the reason where the user clicked.
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

    // MARK: - Hero header

    @ViewBuilder
    private var heroHeader: some View {
        VStack(spacing: Spacing.sm) {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(theme.current.accent.opacity(theme.current.isDark ? 0.20 : 0.12))
                    .frame(width: 56, height: 56)
                Image(systemName: "waveform.and.mic")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(theme.current.accent)
            }
            Text("LLM IDE")
                .font(Typography.display)
                .foregroundStyle(theme.current.text)
            Text(mode == .login ? "Sign in to continue" : "Create an account")
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
        }
    }

    /// Renders a labelled text/secure field.  When `revealable` is true a
    /// trailing eye button toggles between a masked `SecureField` and a plain
    /// `TextField` so the user can show/hide what they typed.
    @ViewBuilder
    private func field(label: String, placeholder: String, text: Binding<String>,
                       secure: Bool, isEmail: Bool = false, field: Field,
                       revealable: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionLabel(label, size: 11, tracking: 0.4)
            HStack(spacing: Spacing.sm) {
                Group {
                    if secure && !(revealable && revealPassword) {
                        SecureField(placeholder, text: text)
                            .focused($focused, equals: field)
                            .onSubmit { submit() }
                    } else if secure {
                        TextField(placeholder, text: text)
                            .focused($focused, equals: field)
                            .onSubmit { submit() }
                    } else {
                        TextField(placeholder, text: text)
                            .textContentType(isEmail ? .emailAddress : nil)
                            .focused($focused, equals: field)
                            .onSubmit {
                                switch field {
                                case .displayName: focused = .email
                                case .email:       focused = .password
                                case .password:    submit()
                                }
                            }
                    }
                }
                .textFieldStyle(.plain)
                .font(Typography.body)
                .foregroundStyle(theme.current.text)

                if revealable {
                    Button {
                        revealPassword.toggle()
                        focused = field
                    } label: {
                        Image(systemName: revealPassword ? "eye.slash.fill" : "eye.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(theme.current.textMuted)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(revealPassword ? "Hide password" : "Show password")
                    .accessibilityLabel(revealPassword ? "Hide password" : "Show password")
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(theme.current.surface2)
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.sm)
                            .strokeBorder(theme.current.border, lineWidth: 0.5)
                    )
            )
            .disableAutocorrection(true)
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

    /// Launch the local backend from the login screen.
    /// Mirrors the call BackendSettingsSection makes, but first repairs
    /// stale stored paths (repo moved/renamed since they were saved) so
    /// the button still works when the config predates the current
    /// checkout location.
    private func startServer() {
        BackendManager.resolveLaunchPaths(config: config)
        backend.start(
            nodePath: config.backendNodePath,
            workingDirectory: config.backendWorkingDir)
    }

    private func submit() {
        busy = true
        error = nil
        serverUnreachable = false
        Task {
            defer { busy = false }
            do {
                if mode == .login {
                    let s = try await api.login(email: email, password: password)
                    await MainActor.run { session.adopt(session: s) }
                } else {
                    _ = try await api.register(email: email, password: password,
                                               displayName: displayName.isEmpty ? nil : displayName)
                    let s = try await api.login(email: email, password: password)
                    await MainActor.run { session.adopt(session: s) }
                }
            } catch let APIError.http(_, _, message, _) {
                await MainActor.run {
                    error = message
                    serverUnreachable = false
                }
            } catch let APIError.network(underlying) {
                // Detect connection-refused so we know to show "Start Server".
                let ns = underlying as NSError
                let isRefused = ns.domain == NSURLErrorDomain &&
                    (ns.code == NSURLErrorCannotConnectToHost ||
                     ns.code == NSURLErrorCannotFindHost)
                await MainActor.run {
                    error = APIError.network(underlying).localizedDescription
                    serverUnreachable = isRefused
                }
                // A live connection-refused contradicts a cached `.running`
                // status (e.g. an adopted backend that has since died). Re-probe
                // so the banner reflects reality — otherwise it shows both
                // "Could not reach the server" and "Server is running".
                if isRefused { await backend.reconcileHealthAfterFailure() }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    serverUnreachable = false
                }
            }
        }
    }

    private func fetchWellKnown() async {
        if let info = try? await api.wellKnown() {
            await MainActor.run { registrationOpen = info.registrationOpen }
        }
    }
}
