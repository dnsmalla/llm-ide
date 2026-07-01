import SwiftUI

/// Configure / edit the Slack source. The bot **token** is written to the
/// server secrets vault (`slack.botToken`) — never to AppConfig.
/// When editing an existing source the token field starts blank and is
/// only re-sent if the user types a new one ("leave blank to keep current").
struct SlackSourceSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(\.dismiss) private var dismiss

    /// Draft seeded from the existing source (or defaults for first setup).
    @State private var draft: SavedSlackSource
    /// True when we're editing an already-saved source (drives the
    /// "leave blank to keep current" token hint + save semantics).
    private let isEditing: Bool

    /// Raw channels text (comma-separated channel IDs shown in the field).
    @State private var channelsText: String
    @State private var token: String = ""
    @State private var tokenVisible = false
    @State private var testing = false
    @State private var testStatus: String?
    @State private var testWasError = false

    init(api: LlmIdeAPIClient) {
        self.api = api
        let existing = AppConfig.shared.slackSource
        _draft = State(initialValue: existing ?? SavedSlackSource())
        isEditing = existing != nil
        _channelsText = State(initialValue: existing?.channels.joined(separator: ", ") ?? "")
    }

    /// Test only makes sense once we have a token to authenticate with.
    private var canTest: Bool {
        !token.isEmpty && !testing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(isEditing ? "Edit Slack Source" : "Add Slack Source")
                .font(Typography.title)
                .padding(Spacing.lg)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    field("Display name") {
                        TextField("My workspace (optional)", text: $draft.displayName)
                            .textFieldStyle(.roundedBorder)
                    }
                    field("Bot token") {
                        ZStack(alignment: .trailing) {
                            Group {
                                if tokenVisible {
                                    TextField("", text: $token)
                                } else {
                                    SecureField("", text: $token)
                                }
                            }
                            .textFieldStyle(.roundedBorder)
                            .font(Typography.mono)
                            .disableAutocorrection(true)
                            Button { tokenVisible.toggle() } label: {
                                Image(systemName: tokenVisible ? "eye.slash" : "eye")
                                    .font(.system(size: 11))
                                    .foregroundStyle(theme.current.textMuted)
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing, 8)
                            .help(tokenVisible ? "Hide token" : "Show token")
                            .accessibilityLabel(tokenVisible ? "Hide token" : "Show token")
                        }
                    }
                    if isEditing {
                        SettingsHint("Leave the token blank to keep the current one.")
                    }
                    field("Channels") {
                        TextField("C0123ABCD, C0456EFGH", text: $channelsText)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    SettingsHint("Comma-separated channel IDs (e.g. C0123ABCD). The bot must be invited to each channel.")
                    field("Lookback days") {
                        Stepper(value: $draft.lookbackDays, in: 1...60) {
                            Text("\(draft.lookbackDays) day\(draft.lookbackDays == 1 ? "" : "s")")
                                .font(Typography.body)
                        }
                        .frame(width: 200)
                    }
                    field("Enabled") {
                        Toggle("", isOn: $draft.enabled)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }

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
                    .help("Remove this source and delete the stored bot token.")
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
        .frame(minWidth: 440, idealWidth: 480, minHeight: 460)
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

    /// Write the token to the vault FIRST (so the server can read it),
    /// then run the connectivity probe.
    private func test() async {
        testing = true
        testStatus = nil
        defer { testing = false }
        do {
            try await api.setSecret(key: "slack.botToken", value: token)
            let r = try await api.testSlack()
            testWasError = !r.ok
            testStatus = r.ok
                ? "Connected to \(r.team)"
                : "Test failed."
        } catch {
            testWasError = true
            testStatus = error.localizedDescription
        }
    }

    /// Persist the source. Only re-send the token when the user typed one
    /// (blank on edit = keep the stored secret untouched).
    private func save() async {
        if !token.isEmpty {
            do {
                try await api.setSecret(key: "slack.botToken", value: token)
            } catch {
                testWasError = true
                testStatus = "Couldn't save token: \(error.localizedDescription)"
                return
            }
        }
        let channels = channelsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        draft.channels = channels
        config.slackSource = draft
        dismiss()
    }

    /// Remove the source and delete the stored bot token from the vault
    /// (empty value = delete, per the secrets endpoint). If clearing the
    /// secret fails we keep the source so the token isn't silently orphaned.
    private func disconnect() async {
        do {
            try await api.setSecret(key: "slack.botToken", value: "")
        } catch {
            testWasError = true
            testStatus = "Couldn't remove the stored token: \(error.localizedDescription)"
            return
        }
        config.slackSource = nil
        dismiss()
    }
}
