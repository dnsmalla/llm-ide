import SwiftUI
import AppKit

/// Configure / edit the Email source. The IMAP **app password** is written
/// to the server secrets vault (`email.imapPassword`) — never to AppConfig.
/// When editing an existing source the password field starts blank and is
/// only re-sent if the user types a new one ("leave blank to keep current").
struct EmailSourceSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(\.dismiss) private var dismiss

    /// Draft seeded from the existing source (or defaults for first setup).
    @State private var draft: SavedEmailSource
    /// True when we're editing an already-saved source (drives the
    /// "leave blank to keep current" password hint + save semantics).
    private let isEditing: Bool

    @State private var password: String = ""
    @State private var passwordVisible = false
    @State private var testing = false
    @State private var testStatus: String?
    @State private var testWasError = false

    /// "password" | "google" — mirrors `draft.authMethod`, kept in a
    /// separate @State because `draft` can't be read inside its own
    /// stored-property initializer.
    @State private var authMethod: String
    @State private var clientId: String = ""
    @State private var clientSecret: String = ""
    @State private var signingIn = false
    @State private var signInError: String?

    init(api: LlmIdeAPIClient) {
        self.api = api
        let existing = AppConfig.shared.emailSource
        _draft = State(initialValue: existing ?? SavedEmailSource())
        isEditing = existing != nil
        _authMethod = State(initialValue: existing?.authMethod ?? "password")
    }

    /// Test only makes sense once we have somewhere to connect + a password
    /// to authenticate with. In Google mode "Test" isn't the primary path
    /// (sign-in itself proves connectivity), so it's gated on host/user only.
    private var canTest: Bool {
        guard !draft.host.trimmingCharacters(in: .whitespaces).isEmpty,
              !draft.user.trimmingCharacters(in: .whitespaces).isEmpty,
              !testing else { return false }
        return authMethod == "google" || !password.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(isEditing ? "Edit Email Source" : "Add Email Source")
                .font(Typography.title)
                .padding(Spacing.lg)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    field("Display name") {
                        TextField("My inbox (optional)", text: $draft.displayName)
                            .textFieldStyle(.roundedBorder)
                    }
                    field("IMAP host") {
                        TextField("imap.gmail.com", text: $draft.host)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Port") {
                        TextField("993", value: $draft.port, format: .number.grouping(.never))
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 90)
                    }
                    field("Use SSL") {
                        Toggle("", isOn: $draft.secure)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                    field("Email address") {
                        TextField("you@example.com", text: $draft.user)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Sign-in method") {
                        Picker("", selection: $authMethod) {
                            Text("App password").tag("password")
                            Text("Sign in with Google").tag("google")
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(width: 260)
                        .onChange(of: authMethod) { _, newValue in
                            draft.authMethod = newValue
                        }
                    }

                    if authMethod == "password" {
                        field("App password") {
                            ZStack(alignment: .trailing) {
                                Group {
                                    if passwordVisible {
                                        TextField("", text: $password)
                                    } else {
                                        SecureField("", text: $password)
                                    }
                                }
                                .textFieldStyle(.roundedBorder)
                                .font(Typography.mono)
                                .disableAutocorrection(true)
                                Button { passwordVisible.toggle() } label: {
                                    Image(systemName: passwordVisible ? "eye.slash" : "eye")
                                        .font(.system(size: 11))
                                        .foregroundStyle(theme.current.textMuted)
                                }
                                .buttonStyle(.plain)
                                .padding(.trailing, 8)
                                .help(passwordVisible ? "Hide password" : "Show password")
                                .accessibilityLabel(passwordVisible ? "Hide password" : "Show password")
                            }
                        }
                        if isEditing {
                            SettingsHint("Leave the password blank to keep the current one.")
                        }
                        // Gmail helper — the most common gotcha is using the
                        // account password instead of an app password.
                        SettingsHint("Gmail: enable 2-Step Verification, then create an App Password (myaccount.google.com → Security → App passwords).")
                    } else {
                        field("Client ID") {
                            TextField("xxxx.apps.googleusercontent.com", text: $clientId)
                                .textFieldStyle(.roundedBorder)
                                .disableAutocorrection(true)
                        }
                        field("Client secret") {
                            SecureField("", text: $clientSecret)
                                .textFieldStyle(.roundedBorder)
                                .font(Typography.mono)
                                .disableAutocorrection(true)
                        }
                        field("") {
                            Button(signingIn ? "Signing in…" : "Sign in with Google") {
                                Task { await signInWithGoogle() }
                            }
                            .buttonStyle(.bordered)
                            .disabled(signingIn
                                      || clientId.trimmingCharacters(in: .whitespaces).isEmpty
                                      || clientSecret.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        if let err = signInError {
                            Text(err)
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if draft.authMethod == "google" && !draft.user.isEmpty {
                            SettingsHint("Signed in as \(draft.user).")
                        }
                        SettingsHint("One-time setup: Google Cloud console → OAuth consent screen (External, add yourself as a test user) → Credentials → Create OAuth client ID → Desktop app → paste the client ID + secret here. Enable IMAP in Gmail.")
                    }
                    field("Mailbox") {
                        TextField("INBOX", text: $draft.mailbox)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Lookback days") {
                        Stepper(value: $draft.lookbackDays, in: 1...60) {
                            Text("\(draft.lookbackDays) day\(draft.lookbackDays == 1 ? "" : "s")")
                                .font(Typography.body)
                        }
                        .frame(width: 200)
                    }
                    field("Unread only") {
                        Toggle("", isOn: $draft.unreadOnly)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                    field("From filter") {
                        TextField("sender@example.com (optional)", text: $draft.fromFilter)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Enabled") {
                        Toggle("", isOn: $draft.enabled)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                    SettingsHint("On connect, Email captures mail from now on (like meeting capture) — it won't import your whole backlog. \"Lookback days\" only caps how far back a catch-up fetch reaches.")

                    if let s = testStatus {
                        Text(s)
                            .font(Typography.caption)
                            .foregroundStyle(testWasError ? theme.current.danger : theme.current.accent3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(Spacing.lg)
            }

            Divider()

            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if isEditing {
                    Button("Disconnect", role: .destructive) {
                        Task { await disconnect() }
                    }
                    .help("Remove this source and delete the stored app password.")
                }
                Spacer()
                Button(testing ? "Testing…" : "Test") {
                    Task { await test() }
                }
                .buttonStyle(.bordered)
                .disabled(!canTest)
                Button("Save") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
            .padding(Spacing.lg)
        }
        .frame(minWidth: 440, idealWidth: 480, minHeight: 520)
        .background(theme.current.body)
    }

    // MARK: - Field row

    @ViewBuilder
    private func field<Content: View>(_ label: String,
                                      @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: Spacing.md) {
            Text(label)
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
                .frame(width: 120, alignment: .leading)
            content()
            Spacer(minLength: 0)
        }
    }

    // MARK: - Actions

    /// Write the password to the vault FIRST (so the server can read it),
    /// then run the connectivity probe.
    private func test() async {
        testing = true
        testStatus = nil
        defer { testing = false }
        do {
            try await api.setSecret(key: "email.imapPassword", value: password)
            let r = try await api.testEmail(draft)
            testWasError = !r.ok
            testStatus = r.ok
                ? "Connected · \(r.total) messages in \(r.mailbox)"
                : "Test failed."
        } catch {
            testWasError = true
            testStatus = error.localizedDescription
        }
    }

    /// Persist the source. Only re-send the password when the user typed
    /// one (blank on edit = keep the stored secret untouched).
    private func save() async {
        if !password.isEmpty {
            do {
                try await api.setSecret(key: "email.imapPassword", value: password)
            } catch {
                testWasError = true
                testStatus = "Couldn't save password: \(error.localizedDescription)"
                return
            }
        }
        await initHighWaterMarkIfNeeded()
        config.emailSource = draft
        dismiss()
    }

    /// Initialize the server-side forward-only high-water mark to "now" on
    /// first connect — and when an edit switches to a DIFFERENT account
    /// (host/user/mailbox), so the previous account's mark can't suppress
    /// the new one's mail. Best-effort; if it fails the per-run cap still
    /// bounds any catch-up.
    private func initHighWaterMarkIfNeeded() async {
        let prev = config.emailSource
        let identityChanged = prev?.host != draft.host
            || prev?.user != draft.user
            || prev?.mailbox != draft.mailbox
        if !isEditing || identityChanged {
            try? await api.markEmailSeen(messageIds: [], lastFetchedAt: Date())
        }
    }

    /// Drive the Google OAuth loopback flow: ask the server to stash the
    /// bring-your-own client id/secret + start the flow, open the returned
    /// consent URL in the default browser, then poll `/auth/google/status`
    /// until it reports complete/error or ~3 minutes elapse. `clientId`/
    /// `clientSecret` never touch AppConfig — they're only sent to the
    /// server, which owns persisting them in the vault.
    private func signInWithGoogle() async {
        signingIn = true
        signInError = nil
        defer { signingIn = false }
        do {
            let r = try await api.googleSignInStart(clientId: clientId, clientSecret: clientSecret)
            if let u = URL(string: r.authUrl) { NSWorkspace.shared.open(u) }
            // Poll for up to ~3 minutes (90 * 2s) while the user completes
            // the consent flow in the browser.
            for _ in 0..<90 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await api.googleSignInStatus(state: r.state)
                if s.status == "complete" {
                    draft.authMethod = "google"
                    if let e = s.email, !e.isEmpty { draft.user = e }
                    await initHighWaterMarkIfNeeded()
                    config.emailSource = draft
                    dismiss()
                    return
                }
                if s.status != "pending" {   // "error" or "unknown"
                    signInError = s.message ?? "Sign-in failed"
                    return
                }
            }
            signInError = "Sign-in timed out — try again."
        } catch {
            signInError = error.localizedDescription
        }
    }

    /// Remove the source and delete the stored app password from the vault
    /// (empty value = delete, per the secrets endpoint). The dedup ledger is
    /// left intact so reconnecting the same account won't re-import old mail.
    /// If clearing the secret fails we keep the source so the password isn't
    /// silently orphaned in the vault.
    private func disconnect() async {
        do {
            try await api.setSecret(key: "email.imapPassword", value: "")
        } catch {
            testWasError = true
            testStatus = "Couldn't remove the stored password: \(error.localizedDescription)"
            return
        }
        config.emailSource = nil
        dismiss()
    }
}
