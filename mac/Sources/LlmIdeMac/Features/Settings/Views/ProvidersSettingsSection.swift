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
    /// False until the first vault listing succeeds, so negative badges don't
    /// flash "Not set up" while `configured` is still the empty placeholder.
    @State private var isConfiguredLoaded = false
    @State private var busy: Set<String> = []
    /// Per-provider "Check CLI" verdicts, seeded from `ProviderCliCheckCache`
    /// so a result survives this view being rebuilt on a section switch.
    @State private var cliReady: [String: Bool] = [:]

    var body: some View {
        SettingsSectionCard(icon: "key.horizontal", title: "Model Providers") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Connect providers here. Choose what runs where in Tiers & Roles below.")
                SettingsHint("A key runs over the fast HTTP API and is stored in the server vault, never on disk here. With no key, “Check CLI” confirms the CLI is installed; your CLI login (subscription) is used when it runs. For several named endpoints (GLM, Ollama, …) see Custom Providers below.")
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
            cliReady = ProviderCliCheckCache.results
            await loadConfigured()
            await refreshLiveModels()
        }
        .onChange(of: config.activeCLI) { _, _ in Task { await refreshLiveModels() } }
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

    @ViewBuilder
    private func providerRow(_ p: ProviderCatalog.Entry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: Spacing.sm) {
                // Badges move to a second line rather than squeezing the
                // provider name when the card is narrow.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Spacing.sm) {
                        providerTitle(p)
                        readinessBadges(p)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        providerTitle(p)
                        HStack(spacing: Spacing.sm) { readinessBadges(p) }
                    }
                }
                Spacer(minLength: 0)
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
                if hasCliMode(p) {
                    Button("Check CLI") { Task { await checkCli(p) } }
                        .disabled(busy.contains(p.id))
                        .help("Confirm this provider's CLI is installed; your CLI login (subscription) is used when it runs — no key needed")
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

    /// Provider name. The default is chosen in Tiers & Roles (Standard), not here.
    private func providerTitle(_ p: ProviderCatalog.Entry) -> some View {
        Text(p.label).font(Typography.bodyStrong).lineLimit(1).fixedSize()
    }

    /// Whether this row offers "Check CLI" (subscription mode) — the same
    /// condition that shows the button.
    private func hasCliMode(_ p: ProviderCatalog.Entry) -> Bool {
        guard let tool = p.tool else { return false }
        return !tool.cliExecutable.isEmpty && !p.needsBaseURL
    }

    /// How this provider can run right now, from what the view already knows:
    /// the vault listing (`configured`, names only — whether a key is stored,
    /// not whether it still works) and this app session's "Check CLI" results. The CLI state
    /// is never probed on appear, so an unchecked CLI reads as unknown rather
    /// than "Not set up". The CLI check only proves the CLI is installed (the
    /// server runs `<cli> --version`), not that it is logged in. Negative
    /// badges are suppressed until the vault listing has loaded, and when it
    /// failed: `configured` is then empty, not known to be empty.
    @ViewBuilder
    private func readinessBadges(_ p: ProviderCatalog.Entry) -> some View {
        let hasKey = configured.contains(p.vaultKey)
        let cli = cliReady[p.id]
        if hasKey {
            readinessBadge("API key", icon: "checkmark", color: theme.current.success,
                           help: "An API key is saved in the server vault.",
                           accessibility: "API key saved")
        }
        if cli == true {
            readinessBadge("CLI installed", icon: "checkmark", color: theme.current.success,
                           help: "The provider's CLI was found on this Mac in this session. Your CLI login (subscription) is used when it runs; the login itself is not checked.",
                           accessibility: "CLI installed")
        }
        // A non-chat row (web search) is optional: no badge when it has no key.
        if !hasKey && cli != true && p.tool != nil && isConfiguredLoaded && configuredLoadError == nil {
            if hasCliMode(p) && cli == nil {
                readinessBadge("No key · CLI not checked", icon: nil, color: theme.current.textMuted,
                               help: "No API key is saved. Click “Check CLI” to confirm the CLI is installed.",
                               accessibility: "No API key, CLI not checked")
            } else {
                readinessBadge("Not set up", icon: nil, color: theme.current.warning,
                               help: hasCliMode(p)
                                   ? "No API key is saved and the CLI check failed."
                                   : "No API key is saved. This provider needs a key.",
                               accessibility: "Not set up")
            }
        }
    }

    private func readinessBadge(_ label: String, icon: String?, color: Color, help: String,
                                accessibility: String) -> some View {
        HStack(spacing: 3) {
            if let icon {
                Image(systemName: icon).font(.system(size: 9, weight: .bold))
                    .accessibilityHidden(true)
            }
            Text(label).font(Typography.caption).lineLimit(1)
        }
        .padding(.horizontal, 6).padding(.vertical, 1)
        .background(Capsule().fill(color.opacity(0.15)))
        .foregroundStyle(color)
        .fixedSize()
        .help(help)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibility)
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

    /// Fetch the default provider's live model list into `LiveModelCache`, so
    /// the Tiers & Roles model menus offer everything the account can use.
    /// Best-effort: on failure the built-in list stays.
    private func refreshLiveModels() async {
        guard let tool = AICliTool(rawValue: config.activeCLI),
              let models = try? await api.listProviderModels(tool.provider), !models.isEmpty else { return }
        LiveModelCache.store(models, for: tool.provider)
    }

    private func loadConfigured() async {
        do {
            configured = try await api.configuredSecretKeys()
            configuredLoadError = nil
            isConfiguredLoaded = true
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
                if p.tool?.rawValue == config.activeCLI { await refreshLiveModels() }
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
            // A new key (or endpoint) can unlock a different model list. After
            // the base-URL write: the server lists from the STORED base URL.
            if p.tool?.rawValue == config.activeCLI { await refreshLiveModels() }
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

    /// Check the provider's CLI is installed (subscription mode — no key). Lets
    /// users who run codex/gemini/claude via their own login confirm the CLI
    /// is installed and reachable from the server.
    private func checkCli(_ p: ProviderCatalog.Entry) async {
        busy.insert(p.id); defer { busy.remove(p.id) }
        do {
            let result = try await api.verifyProvider(p.id, mode: "cli", apiKey: nil)
            status[p.id] = (result.ok, result.detail ?? (result.ok ? "CLI ready" : "CLI not found"))
            cliReady[p.id] = result.ok
            ProviderCliCheckCache.results[p.id] = result.ok
        } catch {
            // A transport failure says nothing about the CLI: drop any earlier
            // verdict instead of keeping a stale "installed".
            status[p.id] = (false, error.localizedDescription)
            cliReady[p.id] = nil
            ProviderCliCheckCache.results[p.id] = nil
        }
    }
}

/// "Check CLI" verdicts for the life of the app process, keyed by backend
/// provider id. The server has no per-provider CLI status endpoint and the
/// check spawns the CLI, so it only runs on a click; this keeps that answer
/// across the section view being torn down. A CLI install is per machine,
/// not per account, so sign-out does not need to clear it.
@MainActor
enum ProviderCliCheckCache {
    static var results: [String: Bool] = [:]
}
