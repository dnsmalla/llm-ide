import SwiftUI
import AppKit

/// Configure / edit the Email source. Connecting goes through LLM-IDE's
/// hosted Google OAuth app (agents/google-oauth.mjs, /auth/google/*) — the
/// user clicks "Connect Google", approves in the browser, and gets back a
/// refresh token (vault key google.email.refreshToken) for ongoing Gmail
/// IMAP access via XOAUTH2. A manual App Password, or your own Google Cloud
/// OAuth client (Client ID/Secret), stay available behind "Advanced" for a
/// non-Gmail IMAP host or a workspace past the hosted app's Testing-mode
/// user cap; BYO writes to the same vault keys as before and the server
/// prefers a user's own stored client over the hosted one when refreshing.
struct EmailSourceSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var sourceLinks: SourceLinkStore
    @Environment(\.dismiss) private var dismiss

    /// Draft seeded from the existing source (or defaults for first setup).
    @State private var draft: SavedEmailSource
    /// True when we're editing an already-saved source (drives the
    /// "leave blank to keep current" password hint + save semantics).
    private let isEditing: Bool

    @State private var connecting = false
    @State private var connectError: String?
    @State private var connectTask: Task<Void, Never>?
    @State private var showAdvanced = false

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

    /// True once a Google OAuth connect has produced BOTH a locally-recorded
    /// email address AND a real vault secret — checking only local `draft`
    /// state would show "Connected" for a manually-typed authMethod/email
    /// with no actual token behind it (e.g. via the Advanced fields without
    /// ever completing a sign-in).
    private var isConnectedViaGoogle: Bool {
        sourceLinks.hasSecret(.email) && draft.authMethod == "google" && !draft.user.trimmingCharacters(in: .whitespaces).isEmpty
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

                    if isConnectedViaGoogle {
                        SettingsHint("✓ Connected as \(draft.user).")
                    } else {
                        Button(connecting ? "Connecting…" : "Connect Google") {
                            connectTask = Task { await connectGoogle() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(connecting)
                        if let err = connectError {
                            Text(err)
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        SettingsHint("Opens Google in your browser to approve Gmail access. Google will show an \"unverified app\" notice the first time — click Advanced → Go to LLM-IDE to continue.")
                    }

                    DisclosureGroup("Advanced: IMAP settings, App Password, or your own Google OAuth client", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: Spacing.md) {
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
                                    Text("Your own Google OAuth client").tag("google")
                                }
                                .labelsHidden()
                                .pickerStyle(.segmented)
                                .frame(width: 280)
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
                                        connectTask = Task { await signInWithGoogle() }
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
                                SettingsHint("One-time setup: Google Cloud console → OAuth consent screen (External, add yourself as a test user) → Credentials → Create OAuth client ID → Desktop app → paste the client ID + secret here. Enable IMAP in Gmail.")
                            }
                        }
                        .padding(.top, Spacing.sm)
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
                    field("Mark as read") {
                        Toggle("", isOn: $draft.markRead)
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
                if isEditing || sourceLinks.hasSecret(.email) {
                    Button("Disconnect", role: .destructive) {
                        Task { await disconnect() }
                    }
                    .help("Remove this source and delete the stored credentials.")
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
        .frame(minWidth: 440, idealWidth: 480, minHeight: 560)
        .background(theme.current.body)
        .onDisappear {
            connectTask?.cancel()
        }
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

    /// Drive the hosted Google OAuth loopback flow: ask the server (which
    /// owns its own Google Cloud OAuth client — nothing to paste) to start
    /// the flow, open the returned consent URL in the default browser, then
    /// poll `/auth/google/status` until it reports complete/error or ~3
    /// minutes elapse. Cancellable — if the sheet is dismissed mid-connect,
    /// `onDisappear` cancels this task so it doesn't keep polling (and
    /// potentially mutating state) after the view is gone. If the server
    /// hasn't been configured with a hosted Google OAuth client
    /// (LLMIDE_GOOGLE_CLIENT_ID/SECRET unset), `googleConnectStart()` throws
    /// a 503 whose message ("Google connect isn't set up on this server
    /// yet.") is already user-readable — it surfaces here via
    /// `connectError` like any other failure, no special-casing needed;
    /// the user falls back to Advanced (App Password or their own OAuth
    /// client) in that case.
    private func connectGoogle() async {
        connecting = true
        connectError = nil
        defer { connecting = false }
        do {
            let r = try await api.googleConnectStart()
            guard let u = URL(string: r.authUrl) else {
                connectError = "Couldn't open the Google sign-in link."
                return
            }
            NSWorkspace.shared.open(u)
            for _ in 0..<90 {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await api.googleSignInStatus(state: r.state)
                if s.status == "complete" {
                    draft.authMethod = "google"
                    draft.host = "imap.gmail.com"
                    draft.port = 993
                    draft.secure = true
                    if let e = s.email, !e.isEmpty { draft.user = e }
                    await initHighWaterMarkIfNeeded()
                    config.emailSource = draft
                    await sourceLinks.refresh(api: api)
                    dismiss()
                    return
                }
                if s.status != "pending" {
                    connectError = s.message ?? "Connection failed"
                    return
                }
            }
            connectError = "Connecting timed out — try again."
        } catch is CancellationError {
            // Sheet was dismissed mid-connect — nothing to update on a gone view.
        } catch {
            connectError = error.localizedDescription
        }
    }

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
            if r.ok { await sourceLinks.refresh(api: api) }
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
        await sourceLinks.refresh(api: api)
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

    /// Drive the BYO Google OAuth loopback flow (Advanced fallback): sends
    /// the user's own client id/secret to the server, which persists them
    /// to the per-user vault before running the same PKCE flow. `clientId`/
    /// `clientSecret` never touch AppConfig — they're only sent to the
    /// server, which owns persisting them in the vault.
    private func signInWithGoogle() async {
        signingIn = true
        signInError = nil
        defer { signingIn = false }
        do {
            let r = try await api.googleSignInStart(clientId: clientId, clientSecret: clientSecret)
            guard let u = URL(string: r.authUrl) else {
                signInError = "Couldn't open the Google sign-in link."
                return
            }
            NSWorkspace.shared.open(u)
            for _ in 0..<90 {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await api.googleSignInStatus(state: r.state)
                if s.status == "complete" {
                    draft.authMethod = "google"
                    if let e = s.email, !e.isEmpty { draft.user = e }
                    await initHighWaterMarkIfNeeded()
                    config.emailSource = draft
                    await sourceLinks.refresh(api: api)
                    dismiss()
                    return
                }
                if s.status != "pending" {
                    signInError = s.message ?? "Sign-in failed"
                    return
                }
            }
            signInError = "Sign-in timed out — try again."
        } catch is CancellationError {
            // Sheet was dismissed mid-sign-in — nothing to update on a gone view.
        } catch {
            signInError = error.localizedDescription
        }
    }

    /// Remove the source and delete the stored credentials from the vault —
    /// the app password AND the Google OAuth refresh token / BYO client id
    /// and secret (empty value = delete, per the secrets endpoint; deleting
    /// an absent key is a harmless no-op). The dedup ledger is left intact
    /// so reconnecting the same account won't re-import old mail. If
    /// clearing a secret fails we keep the source so nothing is silently
    /// orphaned in the vault.
    private func disconnect() async {
        do {
            try await api.setSecret(key: "email.imapPassword", value: "")
            try await api.setSecret(key: "google.email.refreshToken", value: "")
            try await api.setSecret(key: "google.email.clientId", value: "")
            try await api.setSecret(key: "google.email.clientSecret", value: "")
        } catch {
            testWasError = true
            testStatus = "Couldn't remove the stored credentials: \(error.localizedDescription)"
            return
        }
        await sourceLinks.refresh(api: api)
        config.emailSource = nil
        dismiss()
    }
}
