import SwiftUI

/// Per-provider API key management + live verification. A configured key
/// routes that provider's models over the fast HTTP API instead of the slow
/// local CLI subprocess. Keys are stored in the server vault (never on disk
/// here) via the generic `setSecret`; verification hits /kb/providers/verify.
struct ProvidersSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    /// Rows come from `ProviderCatalog` — the one list the composer's provider
    /// menu and the usage-limits picker are also built from, so a provider
    /// cannot be offered in one place and missing from another (it was, twice).
    private var providers: [ProviderCatalog.Entry] { ProviderCatalog.all }

    /// The composer's user-added model ids, keyed by backend provider id — the
    /// same store `ChatComposer.addCustomModel` writes. Read here so this
    /// picker offers the same set the composer does (see `modelOptions`).
    @AppStorage("MEETNOTES_CUSTOM_MODELS") private var customModelsRaw = "{}"

    @State private var drafts: [String: String] = [:]
    @State private var baseURLDraft: String = ""
    @State private var status: [String: (ok: Bool, msg: String)] = [:]
    @State private var configured: Set<String> = []
    @State private var busy: Set<String> = []

    var body: some View {
        SettingsSectionCard(icon: "key.horizontal", title: "Model Providers") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Pick the default provider (◉) and model for new Code & Doc Review chats, and add each provider's credentials. A key runs over the fast HTTP API; with no key, “Check CLI” uses your logged-in CLI (subscription). Keys are stored in the server vault — never on disk here. You can also switch provider/model live in the chat composer. For multiple named providers (GLM, Ollama, …), see Custom Providers below.")
                ForEach(providers) { providerRow($0) }
            }
        }
        .task { await loadConfigured() }
        .onAppear(perform: normalizeActiveCLI)
    }

    private func isActive(_ p: ProviderCatalog.Entry) -> Bool {
        guard let tool = p.tool else { return false }
        return config.activeCLI == tool.rawValue
    }

    private func setActive(_ p: ProviderCatalog.Entry) {
        guard let tool = p.tool else { return }
        config.activeCLI = tool.rawValue
        config.defaultModelId = tool.defaultModelId
    }

    /// Keep `activeCLI` pointing at a selectable provider (a stale persisted
    /// value falls back to Claude).
    private func normalizeActiveCLI() {
        guard !AICliTool.selectable.contains(where: { $0.rawValue == config.activeCLI }) else { return }
        config.activeCLI = AICliTool.claudeCode.rawValue
        config.defaultModelId = AICliTool.claudeCode.defaultModelId
    }

    @ViewBuilder
    private func providerRow(_ p: ProviderCatalog.Entry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: Spacing.sm) {
                // Active-default selector (replaces the old CLI Tool radio list).
                // Only show for model providers (tool != nil).
                if p.tool != nil {
                    Button { setActive(p) } label: {
                        Image(systemName: isActive(p) ? "circle.inset.filled" : "circle")
                            .foregroundStyle(isActive(p) ? theme.current.accent : theme.current.textMuted)
                    }
                    .buttonStyle(.plain)
                    .help("Use as the default provider for new chats")
                }
                Text(p.label).font(Typography.bodyStrong)
                if isActive(p) {
                    Text("Active")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.current.accent)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(theme.current.accent.opacity(0.12)).clipShape(Capsule())
                }
                if configured.contains(p.vaultKey) {
                    Text("• configured")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.accent3)
                }
                Spacer()
                if let s = status[p.id] {
                    Image(systemName: s.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(s.ok ? theme.current.accent3 : theme.current.danger)
                }
            }

            if p.needsBaseURL {
                TextField("Base URL — e.g. https://openrouter.ai/api/v1  or  http://localhost:11434/v1",
                          text: $baseURLDraft)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 480)
                if configured.contains("custom.baseUrl") {
                    Text("• base URL set").font(Typography.caption).foregroundStyle(theme.current.accent3)
                }
            }

            HStack(spacing: Spacing.sm) {
                SecureField(p.placeholder, text: bindingFor(p.id))
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 320)
                Button(busy.contains(p.id) ? "Verifying…" : "Save & verify") {
                    Task { await saveAndVerify(p) }
                }
                .disabled(busy.contains(p.id) || (drafts[p.id] ?? "").isEmpty)
                if configured.contains(p.vaultKey) {
                    Button("Clear") { Task { await clear(p) } }
                        .disabled(busy.contains(p.id))
                }
                if let tool = p.tool, !tool.cliExecutable.isEmpty, !p.needsBaseURL {
                    Button("Check CLI") { Task { await checkCli(p) } }
                        .disabled(busy.contains(p.id))
                        .help("Verify this provider's logged-in CLI for subscription mode (no key needed)")
                }
            }

            // Default model for the active provider (folded in from the old
            // CLI Tool section). Custom has no built-in list — its model is
            // chosen in the composer ("Add model…"). Only shown for model
            // providers (tool != nil).
            if isActive(p), let tool = p.tool {
                let options = modelOptions(for: tool)
                if !options.isEmpty {
                    HStack(spacing: Spacing.sm) {
                        Text("Default model")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                        Picker("", selection: $config.defaultModelId) {
                            ForEach(options) { Text($0.displayName).tag($0.id) }
                        }
                        .labelsHidden().pickerStyle(.menu).fixedSize()
                    }
                }
            }

            Text(p.hint)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            if let s = status[p.id] {
                Text(s.msg)
                    .font(Typography.caption)
                    .foregroundStyle(s.ok ? theme.current.accent3 : theme.current.danger)
            }
        }
        .padding(.vertical, 4)
    }

    /// Models to offer for `tool`: its built-in list, plus the ids the user
    /// added in the composer, plus the current selection when it is neither.
    ///
    /// That last clause is the important one. A SwiftUI `Picker` whose
    /// selection matches no tag renders an EMPTY selection, and
    /// `config.defaultModelId` is written from the composer — which offers
    /// live-fetched ids and "Add model…" ids this static list never had. So
    /// adding a model in the composer used to blank out this picker. Including
    /// the live selection guarantees a tag always matches.
    ///
    /// It also gives the Custom provider a picker at all: `tool.models` is
    /// empty for it by design, but a user-added id is a real choice.
    private func modelOptions(for tool: AICliTool) -> [AIModel] {
        var seen = Set<String>()
        var out: [AIModel] = []
        for m in tool.models where seen.insert(m.id).inserted { out.append(m) }
        let added = (try? JSONDecoder().decode([String: [String]].self,
                                               from: Data(customModelsRaw.utf8)))?[tool.provider] ?? []
        for id in added where !id.isEmpty && seen.insert(id).inserted {
            out.append(AIModel(id: id, displayName: id))
        }
        let current = config.defaultModelId
        if !current.isEmpty && seen.insert(current).inserted {
            out.append(AIModel(id: current, displayName: current))
        }
        return out
    }

    private func bindingFor(_ id: String) -> Binding<String> {
        Binding(get: { drafts[id] ?? "" }, set: { drafts[id] = $0 })
    }

    // MARK: - Actions

    private func loadConfigured() async {
        configured = (try? await api.configuredSecretKeys()) ?? []
    }

    private func saveAndVerify(_ p: ProviderCatalog.Entry) async {
        let key = (drafts[p.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        busy.insert(p.id); defer { busy.remove(p.id) }
        do {
            // Custom (OpenAI-compatible) also needs its base URL stored before
            // verification (the server reads it back when probing /models).
            if p.needsBaseURL {
                let base = baseURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !base.isEmpty else {
                    status[p.id] = (false, "Enter a base URL (e.g. https://openrouter.ai/api/v1).")
                    return
                }
                try await api.setSecret(key: "custom.baseUrl", value: base)
                configured.insert("custom.baseUrl")
            }
            try await api.setSecret(key: p.vaultKey, value: key)
            let result = try await api.verifyProvider(p.id, mode: "key", apiKey: nil)
            status[p.id] = (result.ok, result.ok ? "Verified ✓" : (result.detail ?? "Verification failed"))
            if result.ok {
                configured.insert(p.vaultKey)
                drafts[p.id] = ""           // don't keep the secret in view state
            }
        } catch {
            status[p.id] = (false, error.localizedDescription)
        }
    }

    private func clear(_ p: ProviderCatalog.Entry) async {
        busy.insert(p.id); defer { busy.remove(p.id) }
        do {
            try await api.setSecret(key: p.vaultKey, value: "")
            configured.remove(p.vaultKey)
            status[p.id] = (true, "Cleared.")
        } catch {
            status[p.id] = (false, error.localizedDescription)
        }
    }

    /// Verify the provider's logged-in CLI (subscription mode — no key). Lets
    /// users who run codex/gemini/claude via their own login confirm the CLI
    /// is installed and reachable from the server.
    private func checkCli(_ p: ProviderCatalog.Entry) async {
        busy.insert(p.id); defer { busy.remove(p.id) }
        do {
            let result = try await api.verifyProvider(p.id, mode: "cli", apiKey: nil)
            status[p.id] = (result.ok, result.detail ?? (result.ok ? "CLI ready" : "CLI not found"))
        } catch {
            status[p.id] = (false, error.localizedDescription)
        }
    }
}
