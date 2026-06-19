import SwiftUI

/// Per-provider API key management + live verification. A configured key
/// routes that provider's models over the fast HTTP API instead of the slow
/// local CLI subprocess. Keys are stored in the server vault (never on disk
/// here) via the generic `setSecret`; verification hits /kb/providers/verify.
struct ProvidersSettingsSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore

    private struct Provider: Identifiable {
        let id: String          // "anthropic" — the verify-endpoint provider id
        let label: String
        let vaultKey: String     // "claude.apiKey" — the /auth/me/secrets key
        let placeholder: String
        let hint: String
        /// OpenAI-compatible "custom" provider also needs an endpoint base URL.
        var needsBaseURL: Bool = false
    }

    private let providers: [Provider] = [
        Provider(id: "anthropic", label: "Anthropic (Claude)", vaultKey: "claude.apiKey",
                 placeholder: "sk-ant-…",
                 hint: "claude-* models. Also works with no key via your logged-in `claude` CLI (subscription)."),
        Provider(id: "openai", label: "OpenAI (GPT / Codex)", vaultKey: "openai.apiKey",
                 placeholder: "sk-…",
                 hint: "gpt-*, o*, codex-* models. With no key, falls back to your logged-in `codex` CLI (subscription)."),
        Provider(id: "google", label: "Google (Gemini)", vaultKey: "google.apiKey",
                 placeholder: "AIza…",
                 hint: "gemini-* models. With no key, falls back to your logged-in `gemini` CLI (subscription)."),
        Provider(id: "custom", label: "Custom (OpenAI-compatible)", vaultKey: "custom.apiKey",
                 placeholder: "API key (any value for local servers)",
                 hint: "Any OpenAI-compatible endpoint — OpenRouter, Ollama / LM Studio (local), DeepSeek, Mistral. Pick “Custom” in the composer, then add a model.",
                 needsBaseURL: true),
    ]

    @State private var drafts: [String: String] = [:]
    @State private var baseURLDraft: String = ""
    @State private var status: [String: (ok: Bool, msg: String)] = [:]
    @State private var configured: Set<String> = []
    @State private var busy: Set<String> = []

    var body: some View {
        SettingsSectionCard(icon: "key.horizontal", title: "Model Providers") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Add an API key to run a provider over the fast HTTP API, or use “Check CLI” to run it through your logged-in CLI (subscription, no key). Keys are stored in the server vault — never on disk here.")
                ForEach(providers) { providerRow($0) }
            }
        }
        .task { await loadConfigured() }
    }

    @ViewBuilder
    private func providerRow(_ p: Provider) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: Spacing.sm) {
                Text(p.label).font(Typography.bodyStrong)
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
                if !p.needsBaseURL {
                    Button("Check CLI") { Task { await checkCli(p) } }
                        .disabled(busy.contains(p.id))
                        .help("Verify this provider's logged-in CLI for subscription mode (no key needed)")
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

    private func bindingFor(_ id: String) -> Binding<String> {
        Binding(get: { drafts[id] ?? "" }, set: { drafts[id] = $0 })
    }

    // MARK: - Actions

    private func loadConfigured() async {
        configured = (try? await api.configuredSecretKeys()) ?? []
    }

    private func saveAndVerify(_ p: Provider) async {
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

    private func clear(_ p: Provider) async {
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
    private func checkCli(_ p: Provider) async {
        busy.insert(p.id); defer { busy.remove(p.id) }
        do {
            let result = try await api.verifyProvider(p.id, mode: "cli", apiKey: nil)
            status[p.id] = (result.ok, result.detail ?? (result.ok ? "CLI ready" : "CLI not found"))
        } catch {
            status[p.id] = (false, error.localizedDescription)
        }
    }
}
