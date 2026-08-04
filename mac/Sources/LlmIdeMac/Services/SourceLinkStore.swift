import Foundation

/// Vault-aware connection status for the Mac's source connectors (Email/Box/
/// Slack). Holds the set of vault secret keys currently saved (refreshed from
/// the existing `LlmIdeAPIClient.configuredSecretKeys()` — `GET /auth/me/
/// secrets`, never the values) and derives each source's link state from that
/// + the local `AppConfig` source config. Drives the "Connected ✓" badge on
/// the Connections cards and the "✓ Saved in vault" hint in the source sheets,
/// so re-login / rebuild / reinstall on the same Mac re-links with zero
/// credential re-entry.
@MainActor
final class SourceLinkStore: ObservableObject {

    enum SourceKind { case email, box, slack }

    /// The per-source link state shown on the Connections cards.
    enum LinkState {
        /// Local config exists AND the source's secret is in the vault.
        case linked
        /// Local config exists but the vault secret is missing.
        case credentialsNeeded
        /// No local config for this source.
        case notConfigured
    }

    /// Vault secret keys currently set for this user. Empty until the first
    /// successful `refresh(api:)`.
    @Published private(set) var presentKeys: Set<String> = []

    /// True when the most recent `refresh(api:)` failed (offline / server down
    /// / 401). Cards show an unknown "—" badge; `presentKeys` is left as-is.
    @Published private(set) var lastRefreshFailed = false

    /// The vault key(s) whose presence means this source's secret is saved.
    static func secretKeys(_ kind: SourceKind) -> [String] {
        switch kind {
        case .email: return ["email.imapPassword", "google.email.refreshToken"]
        case .box:   return ["box.clientSecret"]
        case .slack: return ["slack.botToken"]
        }
    }

    /// Pure form for testing: true when any of the kind's vault keys is present.
    static func hasSecret(_ kind: SourceKind, presentKeys: Set<String>) -> Bool {
        secretKeys(kind).contains { presentKeys.contains($0) }
    }

    /// Pure form for testing: the card badge state from config + present keys.
    static func linkState(_ kind: SourceKind, configured: Bool, presentKeys: Set<String>) -> LinkState {
        guard configured else { return .notConfigured }
        return hasSecret(kind, presentKeys: presentKeys) ? .linked : .credentialsNeeded
    }

    /// True when this source's secret is in the vault (sheet hint).
    func hasSecret(_ kind: SourceKind) -> Bool { Self.hasSecret(kind, presentKeys: presentKeys) }

    /// Card badge state. `configured` is whether the local AppConfig source
    /// exists (passed in by the card, which already derives it).
    func linkState(_ kind: SourceKind, configured: Bool) -> LinkState {
        Self.linkState(kind, configured: configured, presentKeys: presentKeys)
    }

    /// Refresh `presentKeys` from the server (reuses the existing
    /// `configuredSecretKeys()` — no new endpoint caller). On failure, keeps
    /// the last-known set and sets `lastRefreshFailed` (never wipes to empty).
    func refresh(api: LlmIdeAPIClient) async {
        do {
            presentKeys = try await api.configuredSecretKeys()
            lastRefreshFailed = false
        } catch {
            lastRefreshFailed = true
        }
    }
}
