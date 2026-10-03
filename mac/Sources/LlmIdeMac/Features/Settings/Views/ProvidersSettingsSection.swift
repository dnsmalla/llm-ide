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
    /// same store `CodeAssistantModelState.addCustomModel` writes. Read here so this
    /// picker offers the same set the composer does (see `modelOptions`).
    @AppStorage("MEETNOTES_CUSTOM_MODELS") private var customModelsRaw = "{}"

    @State private var drafts: [String: String] = [:]
    @State private var baseURLDraft: String = ""
    /// Non-secret copy of the last saved custom base URL. The vault is
    /// write-only, so without this the field could never be prefilled and
    /// changing only the base URL meant retyping the key.
    @AppStorage("MEETNOTES_CUSTOM_BASE_URL_HINT") private var savedBaseURL = ""
    /// Set when the vault listing failed; otherwise every provider would
    /// silently read "not configured" and Clear would be hidden.
    @State private var configuredLoadError: String?
    @State private var status: [String: (ok: Bool, msg: String)] = [:]
    @State private var configured: Set<String> = []
    @State private var busy: Set<String> = []

    var body: some View {
        SettingsSectionCard(icon: "key.horizontal", title: "Model Providers") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Pick the default provider (◉) and model for new Code & Doc Review chats, and add each provider's credentials. A key runs over the fast HTTP API; with no key, “Check CLI” uses your logged-in CLI (subscription). Keys are stored in the server vault — never on disk here. You can also switch provider/model live in the chat composer. For multiple named providers (GLM, Ollama, …), see Custom Providers below.")
                if let configuredLoadError {
                    Text(configuredLoadError)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(providers) { providerRow($0) }

                Divider().padding(.vertical, Spacing.sm)

                agentEngineToggle
            }
        }
        .task {
            if baseURLDraft.isEmpty { baseURLDraft = savedBaseURL }
            await loadConfigured()
        }
        .onAppear(perform: normalizeActiveCLI)
    }

    @AppStorage(AgentV2Selection.toggleKey) private var useAgentV2 = true

    @ViewBuilder
    private var agentEngineToggle: some View {
        Toggle(isOn: $useAgentV2) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Agent engine (Code Assistant)")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Text("New chats use the Claude Agent engine when their provider can run it: Claude, or a custom provider with an Anthropic-compatible URL (Custom Providers below). Other providers get the classic engine. Turn off to use the classic engine everywhere.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        SettingsHint("The Agent engine answers AskUserQuestion cards mid-turn and keeps its own server-side session per chat. It speaks the Anthropic API only: the built-in OpenAI, Gemini, DeepSeek and GLM entries above stay on the classic engine — to run GLM, DeepSeek or Ollama on the Agent engine, register them under Custom Providers with their Anthropic-compatible URL. Phone-driven background chats always use the classic engine.")
    }

    private func isActive(_ p: ProviderCatalog.Entry) -> Bool {
        guard let tool = p.tool else { return false }
        return config.activeCLI == tool.rawValue
    }

    private func setActive(_ p: ProviderCatalog.Entry) {
        guard let tool = p.tool else { return }
        let changed = config.activeCLI != tool.rawValue
        config.activeCLI = tool.rawValue
        // Re-clicking the active provider must not wipe the user's Default
        // model or the purpose picks — only a real provider change resets them.
        guard changed else { return }
        config.defaultModelId = tool.defaultModelId
        config.resetPurposeModels()
        config.modelPickIsExplicit = false
    }

    /// Keep `activeCLI` pointing at a selectable provider (a stale persisted
    /// value falls back to Claude).
    private func normalizeActiveCLI() {
        guard !AICliTool.selectable.contains(where: { $0.rawValue == config.activeCLI }) else { return }
        config.activeCLI = AICliTool.claudeCode.rawValue
        config.defaultModelId = AICliTool.claudeCode.defaultModelId
        config.resetPurposeModels()
        config.modelPickIsExplicit = false
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
                .disabled(busy.contains(p.id) || !canSave(p))
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
                        Picker("", selection: defaultModelBinding) {
                            ForEach(options) { Text($0.displayName).tag($0.id) }
                        }
                        .labelsHidden().pickerStyle(.menu).fixedSize()
                    }
                    PurposeModelPickers(options: options)
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
            out.append(AIModel(id: current, displayName: AIModel.knownName(for: current, in: out) ?? current))
        }
        return out
    }

    /// The Default picker must also drop a composer pick, like the purpose
    /// pickers do — the hint under them promises "until you change a model here".
    // NOTE: uses the property directly; fold into a Config API if one appears.
    private var defaultModelBinding: Binding<String> {
        Binding(
            get: { config.defaultModelId },
            set: { config.defaultModelId = $0; config.modelPickIsExplicit = false })
    }

    /// A key is needed unless the row only changes the base URL of a provider
    /// whose key is already in the vault.
    private func canSave(_ p: ProviderCatalog.Entry) -> Bool {
        if !(drafts[p.id] ?? "").isEmpty { return true }
        guard p.needsBaseURL, configured.contains(p.vaultKey) else { return false }
        let base = baseURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !base.isEmpty && base != savedBaseURL
    }

    private func bindingFor(_ id: String) -> Binding<String> {
        Binding(get: { drafts[id] ?? "" }, set: { drafts[id] = $0 })
    }

    // MARK: - Actions

    private func loadConfigured() async {
        do {
            configured = try await api.configuredSecretKeys()
            configuredLoadError = nil
        } catch {
            configuredLoadError = "Couldn't read which keys are stored (\(error.localizedDescription)). Rows below may show as not configured when they are."
        }
    }

    private func saveAndVerify(_ p: ProviderCatalog.Entry) async {
        let key = (drafts[p.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        busy.insert(p.id); defer { busy.remove(p.id) }
        do {
            var base: String?
            if p.needsBaseURL {
                let b = baseURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !b.isEmpty else {
                    status[p.id] = (false, "Enter a base URL (e.g. https://openrouter.ai/api/v1).")
                    return
                }
                // The key is sent to this URL on every request, so plain http
                // to a remote host would expose it (stored or newly entered).
                guard !EndpointSecurity.isInsecureRemoteHTTP(b) else {
                    status[p.id] = (false, "Plain http to a non-local host would send your API key unencrypted. Use https.")
                    return
                }
                base = b
            }
            guard !key.isEmpty else {
                // Base-URL-only change: the stored key stays, so there is
                // nothing to verify against here.
                guard let base, configured.contains(p.vaultKey) else { return }
                try await api.setSecret(key: "custom.baseUrl", value: base)
                configured.insert("custom.baseUrl")
                savedBaseURL = base
                status[p.id] = (true, "Base URL saved (key unchanged — not re-verified).")
                return
            }
            // Verify BEFORE saving (the server accepts the candidate key and
            // base URL in the body). Saving first left a key that failed
            // verification live in the vault — used by every request — while
            // this row still said "not configured", replacing a working key.
            let result = try await api.verifyProvider(p.id, mode: "key", apiKey: key, baseUrl: base)
            status[p.id] = (result.ok, result.ok ? "Verified ✓" : (result.detail ?? "Verification failed — key not saved"))
            guard result.ok else { return }
            // Key first: if the second write fails the base URL is the stale
            // half, which the message below names, instead of a new URL
            // paired with a key that was never stored.
            try await api.setSecret(key: p.vaultKey, value: key)
            configured.insert(p.vaultKey)
            drafts[p.id] = ""           // don't keep the secret in view state
            if let base {
                do {
                    try await api.setSecret(key: "custom.baseUrl", value: base)
                    configured.insert("custom.baseUrl")
                    savedBaseURL = base
                } catch {
                    status[p.id] = (false, "Key saved, but the base URL was not: \(error.localizedDescription)")
                }
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
