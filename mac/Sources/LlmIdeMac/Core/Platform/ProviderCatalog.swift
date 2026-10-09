import Foundation

/// The single list of providers the app offers, and the display metadata each
/// one needs.
///
/// Three separate literals used to encode this — `AICliTool.selectable` (what
/// the composer offers), `ProvidersSettingsSection.providers` (what you can key)
/// and `ModelLimitsPanel.providerOptions` (what you can cap) — and they drifted:
/// GLM appeared only in the first (and silently answered as Claude, having no
/// backend route), DeepSeek was missing from the third, so it could be selected
/// and keyed but never capped. All three now derive from `all` below, so adding
/// or removing a provider is one edit and cannot half-land.
///
/// Not in here: **named Custom Providers**. Those are user-created rows stored
/// at runtime (`CustomProvider`, reaching the wire as `custom:<uuid>`) with
/// their own base URL and model list — that is how Z.AI GLM, self-hosted
/// endpoints, and anything else OpenAI-compatible are added, and it needs no
/// code change. `custom` below is the single shared OpenAI-compatible endpoint,
/// a different thing.
enum ProviderCatalog {
    struct Entry: Identifiable {
        /// Backend provider id — what `/kb/providers/verify` and the usage
        /// ledger are keyed by (`"anthropic"`, not `"claude_code"`). Also the
        /// `Identifiable` id, so per-row UI state keys off the same string the
        /// server uses.
        let id: String
        /// The composer/CLI tool this provider maps to. `nil` for a credential
        /// row that is not a chat provider (web search), which is why it is
        /// optional rather than absent: those rows still need a key field.
        let tool: AICliTool?
        /// Settings row label.
        let label: String
        /// Compact label for space-constrained pickers (the limits segmented
        /// control). Falls back to `label`.
        let shortLabel: String
        /// `/auth/me/secrets` key holding this provider's credential.
        let vaultKey: String
        let placeholder: String
        let hint: String
        /// OpenAI-compatible "custom" also needs an endpoint base URL.
        var needsBaseURL: Bool = false
    }

    /// Backend id of the Jev decision provider (vault key `jev.apiKey`).
    static let jevId = "jev"

    /// Every row Settings → Model Providers renders, in display order.
    static let all: [Entry] = [
        Entry(id: ClaudeCLI.provider, tool: .claudeCode,
              label: "Anthropic (Claude)", shortLabel: "Claude",
              vaultKey: ClaudeCLI.vaultKey, placeholder: "sk-ant-…",
              hint: "claude-* models. Also works with no key via your logged-in `claude` CLI (subscription). The only provider the Claude Agent engine can run."),
        Entry(id: "openai", tool: .openai,
              label: "OpenAI (GPT / Codex)", shortLabel: "OpenAI",
              vaultKey: "openai.apiKey", placeholder: "sk-…",
              hint: "gpt-*, o*, codex-* models. A key runs the full tool loop; with no key your logged-in `codex` CLI answers the turn read-only, without this app's tools."),
        Entry(id: "google", tool: .gemini,
              label: "Google (Gemini)", shortLabel: "Gemini",
              vaultKey: "google.apiKey", placeholder: "AIza…",
              hint: "gemini-* models. A key runs the full tool loop over Gemini's OpenAI-compatible endpoint; with no key your logged-in `gemini` CLI answers the turn."),
        Entry(id: "deepseek", tool: .deepseek,
              label: "DeepSeek", shortLabel: "DeepSeek",
              vaultKey: "deepseek.apiKey", placeholder: "sk-…",
              hint: "deepseek-chat, deepseek-reasoner models. Key required — DeepSeek has no CLI subscription mode."),
        Entry(id: "custom", tool: .custom,
              label: "Custom (OpenAI-compatible)", shortLabel: "Custom",
              vaultKey: "custom.apiKey", placeholder: "API key (any value for local servers)",
              hint: "One shared OpenAI-compatible endpoint — OpenRouter, Ollama / LM Studio (local), Mistral. Choose it as a tier (e.g. Standard) in Tiers & Roles below — its models are read from the endpoint; add one by hand with Add model… in the chat composer. For several named endpoints at once, use Custom Providers.",
              needsBaseURL: true),
        // WHY tool nil: Jev is a decision API, not a chat model. With no
        // `tool` it is left out of `modelProviders` — so it never reaches the
        // composer, `AICliTool.selectable` or the usage-limits picker (the
        // server's limits know only anthropic/openai/google/custom). It is
        // reached as a tier provider for the Decisions role only
        // (`TierRouting.decisionOnlyProvider`).
        Entry(id: jevId, tool: nil,
              label: "Jev (decisions)", shortLabel: "Jev",
              vaultKey: "jev.apiKey", placeholder: "Jev API key",
              hint: "Decision-only: answers yes/no, pick-one and score questions with calibrated probabilities. Used by the Decisions role in Tiers & Roles below and by the agent's `decide` tool — not a chat model, so it never appears in the chat composer. Key required."),
        Entry(id: "web-search", tool: nil,
              label: "Web Search (SerpAPI, optional)", shortLabel: "Web Search",
              vaultKey: "serpapi.apiKey",
              placeholder: "Optional — your SerpAPI key from https://serpapi.com",
              hint: "Web search works automatically through your Claude login (or Anthropic API key) — no setup needed. A SerpAPI key is only an optional fallback."),
    ]

    /// The rows Settings → Model Providers shows against a server on
    /// `serverApiVersion`: Jev only from API v73 (`decisionsServerApiVersion`)
    /// — an older server's vault refuses `jev.apiKey`, so its row could only
    /// fail. Unknown version hides it too (fail closed).
    static func visibleRows(serverApiVersion: Int?) -> [Entry] {
        all.filter { $0.id != jevId || TierRouting.serverSupportsDecisions(serverApiVersion) }
    }

    /// Rows that are chat providers — everything with a `tool`. Excludes the
    /// credential-only rows (web search) and the decision-only Jev row.
    static var modelProviders: [Entry] { all.filter { $0.tool != nil } }

    /// The tools the composer may offer. `AICliTool.selectable` returns this.
    static var selectableTools: [AICliTool] { modelProviders.compactMap(\.tool) }

    /// (id, label) pairs for the usage-limits provider picker.
    static var limitProviders: [(id: String, label: String)] {
        modelProviders.map { (id: $0.id, label: $0.shortLabel) }
    }
}
