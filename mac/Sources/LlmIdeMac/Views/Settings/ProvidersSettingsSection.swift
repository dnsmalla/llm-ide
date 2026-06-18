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
    ]

    @State private var drafts: [String: String] = [:]
    @State private var status: [String: (ok: Bool, msg: String)] = [:]
    @State private var configured: Set<String> = []
    @State private var busy: Set<String> = []

    var body: some View {
        SettingsSectionCard(icon: "key.horizontal", title: "Model Providers") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Add an API key per provider to run its models over the fast HTTP API instead of the slow CLI. Keys are stored in the server vault — never on disk here.")
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
}
