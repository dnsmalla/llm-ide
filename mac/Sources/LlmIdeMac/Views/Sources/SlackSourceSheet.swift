import SwiftUI
import AppKit

/// Configure / edit the Slack source. Connecting goes through LLM-IDE's
/// hosted Slack OAuth app (agents/slack-oauth.mjs, /auth/slack/*) — the user
/// clicks "Connect Slack", approves in the browser, and gets back a user
/// token (vault key slack.userToken) plus a checklist of channels/groups
/// they already belong to. No bot to invite, no token to paste. A manual
/// bot-token paste stays available behind "Advanced" for a workspace that
/// blocks new app installs; it writes to the older slack.botToken key,
/// which the server prefers slack.userToken over but falls back to.
struct SlackSourceSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var sourceLinks: SourceLinkStore
    @Environment(\.dismiss) private var dismiss

    /// Draft seeded from the existing source (or defaults for first setup).
    @State private var draft: SavedSlackSource
    /// True when we're editing an already-saved source. Starts from whether
    /// a source existed when the sheet opened, but also flips true the
    /// moment a fresh OAuth connect succeeds — so Disconnect becomes
    /// reachable immediately, even if the user closes the sheet before
    /// tapping Save (the vault token already exists server-side by then).
    @State private var isEditing: Bool

    @State private var selectedChannelIds: Set<String>
    @State private var availableChannels: [LlmIdeAPIClient.SlackConversation] = []
    @State private var channelsIncomplete = false
    @State private var channelsError: String?
    @State private var loadingChannels = false
    @State private var connecting = false
    @State private var connectError: String?
    @State private var connectTask: Task<Void, Never>?

    @State private var showAdvanced = false
    @State private var token: String = ""
    @State private var tokenVisible = false
    @State private var testing = false
    @State private var testStatus: String?
    @State private var testWasError = false

    init(api: LlmIdeAPIClient) {
        self.api = api
        let existing = AppConfig.shared.slackSource
        _draft = State(initialValue: existing ?? SavedSlackSource())
        _isEditing = State(initialValue: existing != nil)
        _selectedChannelIds = State(initialValue: Set(existing?.channels ?? []))
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

                    if sourceLinks.hasSecret(.slack) {
                        SettingsHint("✓ Connected to Slack.")
                        channelChecklist
                    } else {
                        Button(connecting ? "Connecting…" : "Connect Slack") {
                            connectTask = Task { await connectSlack() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(connecting)
                        if let err = connectError {
                            Text(err)
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        SettingsHint("Opens Slack in your browser to approve access. Reads channels you already belong to — no bot to invite.")
                    }

                    DisclosureGroup("Advanced: paste a token manually", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: Spacing.md) {
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
                                SettingsHint("Leave blank to keep the current one.")
                            }
                            SettingsHint("The bot must be invited to each channel you paste below.")
                            if let s = testStatus {
                                Text(s)
                                    .font(Typography.caption)
                                    .foregroundStyle(testWasError ? theme.current.danger : theme.current.accent3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Button(testing ? "Testing…" : "Test token") {
                                Task { await test() }
                            }
                            .buttonStyle(.bordered)
                            .disabled(token.isEmpty || testing)
                        }
                        .padding(.top, Spacing.sm)
                    }

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
                    .help("Remove this source and delete the stored Slack credentials.")
                }
                Spacer()
                Button("Save") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!sourceLinks.hasSecret(.slack) && token.isEmpty)
            }
            .padding(Spacing.lg)
        }
        .frame(minWidth: 460, idealWidth: 500, minHeight: 520)
        .background(theme.current.body)
        .task {
            if sourceLinks.hasSecret(.slack) { await loadChannels() }
        }
        .onDisappear {
            connectTask?.cancel()
        }
    }

    // MARK: - Channel checklist

    @ViewBuilder
    private var channelChecklist: some View {
        HStack {
            Text("Channels")
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
            Spacer()
            Button("Select All") { selectedChannelIds = Set(availableChannels.map(\.id)) }
                .buttonStyle(.plain)
                .font(Typography.caption)
                .disabled(availableChannels.isEmpty)
            Button("Select None") { selectedChannelIds.removeAll() }
                .buttonStyle(.plain)
                .font(Typography.caption)
                .disabled(selectedChannelIds.isEmpty)
            Button(loadingChannels ? "Refreshing…" : "Refresh channels") {
                Task { await loadChannels() }
            }
            .buttonStyle(.plain)
            .font(Typography.caption)
            .disabled(loadingChannels)
        }
        if let err = channelsError {
            SettingsHint("Couldn't refresh channels: \(err)")
        } else if availableChannels.isEmpty && !loadingChannels {
            SettingsHint("Couldn't load channels — Click Refresh channels to try again.")
        } else if channelsIncomplete {
            SettingsHint("Showing \(availableChannels.count) channels — the list may be incomplete (large workspace or Slack rate limit). Click Refresh channels to try again.")
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(availableChannels) { ch in
                    Toggle("#\(ch.name)", isOn: Binding(
                        get: { selectedChannelIds.contains(ch.id) },
                        set: { on in
                            if on { selectedChannelIds.insert(ch.id) } else { selectedChannelIds.remove(ch.id) }
                        }
                    ))
                    .toggleStyle(.checkbox)
                }
            }
        }
        .frame(height: 220)
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

    /// Drive the Slack OAuth loopback flow: ask the server (which owns its
    /// own Slack App credentials — nothing to paste) to start the flow,
    /// open the returned consent URL in the default browser, then poll
    /// `/auth/slack/status` until it reports complete/error or ~3 minutes
    /// elapse.
    private func connectSlack() async {
        connecting = true
        connectError = nil
        defer { connecting = false }
        do {
            let r = try await api.slackConnectStart()
            guard let u = URL(string: r.authUrl) else {
                connectError = "Couldn't open the Slack sign-in link."
                return
            }
            NSWorkspace.shared.open(u)
            for _ in 0..<90 {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await api.slackConnectStatus(state: r.state)
                if s.status == "complete" {
                    await sourceLinks.refresh(api: api)
                    config.slackSource = draft
                    isEditing = true
                    await loadChannels()
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

    /// Refresh the channel checklist from the currently-saved Slack
    /// connection (user token, or a manually-pasted bot token). Keeps
    /// whatever channels were already loaded on failure — one failed
    /// refresh shouldn't blank out a list the user was mid-way through
    /// checking.
    private func loadChannels() async {
        loadingChannels = true
        channelsError = nil
        defer { loadingChannels = false }
        do {
            let result = try await api.fetchSlackConversations()
            availableChannels = result.channels
            channelsIncomplete = !result.complete
        } catch {
            channelsError = error.localizedDescription
        }
    }

    /// Write the token to the vault FIRST (so the server can read it), then
    /// run the connectivity probe. Advanced/manual fallback path only.
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
            if r.ok { await sourceLinks.refresh(api: api) }
        } catch {
            testWasError = true
            testStatus = error.localizedDescription
        }
    }

    /// Persist the source. The manual token (if the user typed one in
    /// Advanced) is saved as slack.botToken; the OAuth-issued slack.userToken
    /// (if present) already lives in the vault from `connectSlack()`.
    private func save() async {
        if !token.isEmpty {
            do {
                try await api.setSecret(key: "slack.botToken", value: token)
                await sourceLinks.refresh(api: api)
            } catch {
                testWasError = true
                testStatus = "Couldn't save token: \(error.localizedDescription)"
                return
            }
        }
        draft.channels = selectedChannelIds.sorted()
        config.slackSource = draft
        dismiss()
    }

    /// Remove the source and delete BOTH possible stored credentials
    /// (OAuth user token + manual bot token — deleting an absent key is a
    /// harmless no-op) so a reconnect starts clean.
    private func disconnect() async {
        do {
            try await api.setSecret(key: "slack.userToken", value: "")
            try await api.setSecret(key: "slack.botToken", value: "")
        } catch {
            testWasError = true
            testStatus = "Couldn't remove the stored Slack credentials: \(error.localizedDescription)"
            return
        }
        await sourceLinks.refresh(api: api)
        config.slackSource = nil
        dismiss()
    }
}
