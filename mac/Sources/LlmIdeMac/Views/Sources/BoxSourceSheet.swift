import SwiftUI

/// Configure / edit the Box source. The CCG **client secret** is written to
/// the server secrets vault (`box.clientSecret`) — never to AppConfig.
/// When editing an existing source the secret field starts blank and is
/// only re-sent if the user types a new one ("leave blank to keep current").
struct BoxSourceSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(\.dismiss) private var dismiss

    /// Draft seeded from the existing source (or defaults for first setup).
    @State private var draft: SavedBoxSource
    /// True when we're editing an already-saved source (drives the
    /// "leave blank to keep current" secret hint + save semantics).
    private let isEditing: Bool

    @State private var clientSecret: String = ""
    @State private var secretVisible = false
    @State private var testing = false
    @State private var testStatus: String?
    @State private var testWasError = false

    init(api: LlmIdeAPIClient) {
        self.api = api
        let existing = AppConfig.shared.boxSource
        _draft = State(initialValue: existing ?? SavedBoxSource())
        isEditing = existing != nil
    }

    /// Test only makes sense once we have a client secret to authenticate with.
    private var canTest: Bool {
        !clientSecret.isEmpty && !testing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(isEditing ? "Edit Box Source" : "Add Box Source")
                .font(Typography.title)
                .padding(Spacing.lg)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    field("Display name") {
                        TextField("My Box folder (optional)", text: $draft.displayName)
                            .textFieldStyle(.roundedBorder)
                    }
                    field("Client ID") {
                        TextField("Box app client ID", text: $draft.clientId)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Client secret") {
                        ZStack(alignment: .trailing) {
                            Group {
                                if secretVisible {
                                    TextField("", text: $clientSecret)
                                } else {
                                    SecureField("", text: $clientSecret)
                                }
                            }
                            .textFieldStyle(.roundedBorder)
                            .font(Typography.mono)
                            .disableAutocorrection(true)
                            Button { secretVisible.toggle() } label: {
                                Image(systemName: secretVisible ? "eye.slash" : "eye")
                                    .font(.system(size: 11))
                                    .foregroundStyle(theme.current.textMuted)
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing, 8)
                            .help(secretVisible ? "Hide secret" : "Show secret")
                            .accessibilityLabel(secretVisible ? "Hide secret" : "Show secret")
                        }
                    }
                    if isEditing {
                        SettingsHint("Leave the client secret blank to keep the current one.")
                    }
                    field("Subject type") {
                        Picker("", selection: $draft.subjectType) {
                            Text("Enterprise").tag("enterprise")
                            Text("User").tag("user")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 200)
                    }
                    field("Subject ID") {
                        TextField("Enterprise or user ID", text: $draft.subjectId)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Folder ID") {
                        TextField("Box folder ID", text: $draft.folderId)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    SettingsHint("Uses a Box Custom App with Client Credentials Grant (CCG). The app must be authorized for the enterprise/user above.")
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
                    .help("Remove this source and delete the stored client secret.")
                }
                Spacer()
                Button(testing ? "Verifying…" : "Save & verify") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(testing)
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

    /// Persist the secret (if a new one was typed) then verify the folder
    /// is reachable before saving the draft.
    private func save() async {
        testing = true
        testStatus = nil
        defer { testing = false }
        if !clientSecret.isEmpty {
            do {
                try await api.setSecret(key: "box.clientSecret", value: clientSecret)
            } catch {
                testWasError = true
                testStatus = "Couldn't save secret: \(error.localizedDescription)"
                return
            }
        }
        do {
            let r = try await api.testBox(clientId: draft.clientId, subjectType: draft.subjectType, subjectId: draft.subjectId, folderId: draft.folderId)
            draft.folderName = r.folderName
        } catch {
            testWasError = true
            testStatus = "Verify failed: \(error.localizedDescription)"
            return
        }
        config.boxSource = draft
        dismiss()
    }

    /// Remove the source and delete the stored client secret from the vault
    /// (empty value = delete, per the secrets endpoint). If clearing the
    /// secret fails we keep the source so the secret isn't silently orphaned.
    private func disconnect() async {
        do {
            try await api.setSecret(key: "box.clientSecret", value: "")
        } catch {
            testWasError = true
            testStatus = "Couldn't remove the secret: \(error.localizedDescription)"
            return
        }
        config.boxSource = nil
        dismiss()
    }
}
