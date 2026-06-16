import SwiftUI

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

    init(api: LlmIdeAPIClient) {
        self.api = api
        let existing = AppConfig.shared.emailSource
        _draft = State(initialValue: existing ?? SavedEmailSource())
        isEditing = existing != nil
    }

    /// Test only makes sense once we have somewhere to connect + a password
    /// to authenticate with.
    private var canTest: Bool {
        !draft.host.trimmingCharacters(in: .whitespaces).isEmpty
            && !draft.user.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !testing
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

                    // Gmail helper — the most common gotcha is using the
                    // account password instead of an app password.
                    SettingsHint("Gmail: enable 2-Step Verification, then create an App Password (myaccount.google.com → Security → App passwords).")

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
        config.emailSource = draft
        dismiss()
    }
}
