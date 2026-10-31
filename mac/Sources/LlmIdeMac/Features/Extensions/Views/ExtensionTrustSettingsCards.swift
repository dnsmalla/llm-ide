import SwiftUI

/// Settings card: folders the user has decided on, with a trusted switch each.
/// Trusting a folder lets its own `.mcp.json` servers start, so switching on asks first.
struct WorkspaceTrustSettingsCard: View {
    @EnvironmentObject var theme: ThemeStore
    @State private var model: WorkspaceTrustListModel

    init(api: LlmIdeAPIClient) { _model = State(initialValue: WorkspaceTrustListModel(api: api)) }

    var body: some View {
        SettingsSectionCard(icon: "lock.shield", title: "Folder trust") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("A project folder is untrusted until you trust it here or from the chat banner. Untrusted folders never start their own MCP servers; hooks and plugins from a project folder are not loaded at all.")
                if !model.enforced {
                    Label("Enforcement is off on this server, so every folder behaves as trusted. The switches below are saved but have no effect until the operator turns it back on.", systemImage: "exclamationmark.triangle")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if model.items.isEmpty {
                    SettingsHint(model.loaded ? "No folder has been decided yet. A folder appears here when a chat reports it as untrusted and you answer." : "Loading folders…")
                }
                ForEach(model.items) { item in
                    HStack(spacing: Spacing.sm) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(WorkspaceTrustPresentation.displayName(item.path)).font(Typography.body)
                            Text(item.path).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        Toggle("Trusted", isOn: Binding(
                            get: { item.trusted },
                            set: { v in Task { await model.requestChange(item, trusted: v) } }
                        ))
                        .labelsHidden()
                        .disabled(model.busy.contains(item.path))
                        .accessibilityLabel("Trust \(item.path)")
                        .accessibilityValue(item.trusted ? "Trusted" : "Not trusted")
                    }
                }
                if let e = model.errorText {
                    Text(e).font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button("Reload") { Task { await model.load() } }
                    .buttonStyle(.bordered).controlSize(.small).disabled(model.loading)
            }
        }
        .task { if !model.loaded { await model.load() } }
        .confirmationDialog("Trust this folder?", isPresented: Binding(
            get: { model.pendingTrust != nil },
            set: { if !$0 { model.pendingTrust = nil } }
        ), titleVisibility: .visible) {
            Button("Trust and allow its MCP servers", role: .destructive) { Task { await model.confirmPendingTrust() } }
            Button("Cancel", role: .cancel) { model.pendingTrust = nil }
        } message: {
            Text(model.confirmation)
        }
    }
}

/// Settings card: which GitHub sources the Extensions screen may install from.
struct ExtensionAllowlistSettingsCard: View {
    @EnvironmentObject var theme: ThemeStore
    @State private var model: ExtensionAllowlistModel

    init(api: LlmIdeAPIClient) { _model = State(initialValue: ExtensionAllowlistModel(api: api)) }

    var body: some View {
        SettingsSectionCard(icon: "checklist", title: "Extension sources") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Extensions install only from sources on this list: the operator's list plus the sources you add. Use owner/repo or owner/*.")
                if let a = model.allowlist {
                    listBlock("Operator list", a.operator, empty: "Empty.")
                    SettingsHint(ExtensionAllowlistText.ceilingText(a.ceiling))
                    yourSources(a)
                    listBlock("In effect", a.effective, empty: "Nothing is allowed yet.")
                } else if model.errorText == nil {
                    SettingsHint("Loading…")
                }
                HStack {
                    TextField("owner/repo or owner/*", text: $model.draft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await model.addDraft() } }
                        .accessibilityLabel("Source to allow")
                    Button("Add") { Task { await model.addDraft() } }
                        .buttonStyle(.bordered).controlSize(.small)
                        .disabled(!model.canAdd)
                }
                if let e = model.errorText {
                    Text(e).font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .task { if model.allowlist == nil { await model.load() } }
    }

    @ViewBuilder
    private func yourSources(_ a: ExtAllowlist) -> some View {
        Text("Your additions").font(Typography.caption).foregroundStyle(theme.current.textMuted)
        if a.user.isEmpty {
            Text("None.").font(Typography.caption)
        }
        ForEach(a.user, id: \.self) { entry in
            let ignored = a.ignored.contains(entry)
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry).font(Typography.body)
                    if ignored {
                        Text(ExtensionAllowlistText.ignoredReason)
                            .font(Typography.caption).foregroundStyle(theme.current.warning)
                    }
                }
                Spacer()
                Button {
                    Task { await model.remove(entry) }
                } label: { Image(systemName: "minus.circle") }
                .buttonStyle(.plain)
                .disabled(model.saving)
                .accessibilityLabel("Remove \(entry)")
                .help("Remove \(entry)")
            }
        }
    }

    @ViewBuilder
    private func listBlock(_ title: String, _ entries: [String], empty: String) -> some View {
        Text(title).font(Typography.caption).foregroundStyle(theme.current.textMuted)
        Text(entries.isEmpty ? empty : entries.joined(separator: ", ")).font(Typography.caption)
            .textSelection(.enabled)
    }
}
