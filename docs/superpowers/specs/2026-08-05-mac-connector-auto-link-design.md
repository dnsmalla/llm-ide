# Mac Source-Connector Auto-Link (vault-aware) — Design

**Date:** 2026-08-05
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/Sources/LlmIdeMac/`) + small server read-path (already exists)

## Goal

Make Email / Box / Slack source setup in the **Mac app** auto-link with **zero re-entry** of credentials after they've been saved once: on re-login, rebuild, or reinstall on the **same Mac**, each source shows as **Connected** automatically, with no re-typing. Fetching stays on-demand (existing Fetch buttons / Auto-Tasks).

## Background — current state (and a premise correction)

**Premise correction:** Email, Box, and Slack source connectors exist **only in the Mac app**. The extension sidepanel's "Connectors" tab wires up **Git / GitHub issues / QA** only (`extension/src/sidepanel/components/ConnectorsSettings.tsx:55-229`) — it has no Email/Box/Slack UI. So this feature builds the easy flow on Mac from scratch; it does not mirror the extension.

Where things live today:
- **Secrets are server-side**, in the encrypted per-user vault (`user_secrets`, AES-256-GCM; `extension/server/vault.mjs:49-67`), keyed by `user_id`. Vault keys used: `email.imapPassword`, `box.clientSecret`, `slack.botToken`, and the Google OAuth trio `google.email.clientId/clientSecret/refreshToken` (`vault.mjs:110-151`).
- **Non-secret config is Mac-local**, in UserDefaults via `AppConfig` (`mac/.../Models/Config.swift:402-430`): `emailSource`, `slackSource`, `boxSource`. The structs deliberately exclude the secret (`Config.swift:61-65`).
- The Mac writes a secret via `POST /auth/me/secrets { key, value }` (`LlmIdeAPIClient+Email.swift:37-43`); empty value = delete.
- **`GET /auth/me/secrets` already returns the set keys** (no values): `{ secrets: [{key, updatedAt}], available: VAULT_KEYS }` (`extension/server/auth-routes.mjs:489-493`). This is the enabler — the Mac can ask "which connector secrets are already saved?" without ever receiving the secrets themselves.
- **Logout does NOT purge the vault** — `AccountSettingsSection.swift:55-66` only clears the local session + `KeychainStore.logout()` (app tokens / saved-projects). Connector secrets persist server-side per user, so they survive logout → re-login. This is what makes same-Mac zero-re-entry possible.
- The Mac sheets are bespoke (`EmailSourceSheet.swift`, `BoxSourceSheet.swift`, `SlackSourceSheet.swift`), surfaced 3 levels deep under Settings → Connections (collapsed) → Configure. Box and Slack have no OAuth (manual paste); only Email has a Google button.

## Decisions (from brainstorming)

- **Primary goal: auto-link = detect existing credentials, zero re-entry.** The vault already syncs secrets across devices by user; the gap is that the Mac never *queries* it to reflect connection state or auto-link.
- **Scope: same-Mac** (re-login / rebuild / reinstall). Secrets via vault; non-secret config stays in UserDefaults. Cross-device "new Mac just works" (syncing non-secret config to the server) is **out of scope** — a brand-new second Mac still needs the host/folderId/channels fields (but never the secrets).
- **Behavior: auto-link STATUS, fetch on demand.** Detecting a saved secret + local config marks a source **Connected**; fetching still happens via the existing Fetch buttons / Auto-Tasks. No auto-fetch on launch.
- **Approach A1 (minimal UX):** a new `SourceLinkStore` + status-aware cards/sheet hints. We do **not** unify the three sheets (deferred), do **not** resurface Connections out of Settings (deferred), and do **not** add OAuth to Box/Slack (deferred).

## Architecture

```
Launch / Connections view appears / sheet save·disconnect
   │
   ▼
SourceLinkStore.refresh()  →  LlmIdeAPIClient.fetchSecretKeys()
   │                            GET /auth/me/secrets → { secrets:[{key,updatedAt}], available }
   ▼                            (set keys only — no values ever leave the vault)
presentKeys: Set<String>  (cached)
   │
   ▼  per source:
isLinked(kind) = (source's vault key ∈ presentKeys) AND (AppConfig.<kind>Source exists)
   │
   ▼
ConnectionsSettingsSection cards  →  badge: Connected ✓ / Credentials needed / Not configured
Email/Box/Slack sheets            →  credential-field hint: "✓ Saved in vault — leave blank to keep"
```

Fetching is unchanged — the badges only reflect link state; the user (or Auto-Tasks) fetches on demand.

## Components

### `mac/.../Services/SourceLinkStore.swift` (new)
An `ObservableObject`, `@MainActor`, singleton (`shared`).
- `@Published private(set) var presentKeys: Set<String> = []`
- `@Published private(set) var lastRefreshFailed: Bool = false`
- `func refresh()` (async) — calls `api.fetchSecretKeys()`, sets `presentKeys` to the returned keys, clears `lastRefreshFailed`; on throw, sets `lastRefreshFailed = true` and **keeps the previous `presentKeys`** (stale-but-useful beats empty).
- `func isLinked(_ kind: SourceKind) -> LinkState` where `LinkState = .linked | .credentialsNeeded | .notConfigured`:
  - Email → `.linked` if (`presentKeys` contains `email.imapPassword` **or** `google.email.refreshToken`) **and** `AppConfig.shared.emailSource != nil`; `.credentialsNeeded` if config exists but no secret; else `.notConfigured`.
  - Box → secret key `box.clientSecret` + `AppConfig.shared.boxSource != nil`.
  - Slack → secret key `slack.botToken` + `AppConfig.shared.slackSource != nil`.
- A lightweight `SourceKind` enum: `.email`, `.box`, `.slack` (extensible for future sources).

### `LlmIdeAPIClient` addition
- `func fetchSecretKeys() async throws -> [(key: String, updatedAt: Date?)]` — `GET /auth/me/secrets`, decode `{ secrets: [{key, updatedAt}], available }`, return the `secrets` list. No server change (endpoint exists). Place near the existing `setSecret` wrapper.

### UX changes (status-aware, not a redesign)
- `ConnectionsSettingsSection.swift` (`emailCard`/`slackCard`/`boxCard` at `:60-62`): each card gains a status badge driven by `SourceLinkStore.shared.isLinked(....)`:
  - `.linked` → green "Connected ✓"
  - `.credentialsNeeded` → amber "Credentials needed"
  - `.notConfigured` → muted "Not configured"
  - when `lastRefreshFailed` → muted "—" (unknown) with a tooltip "Couldn't verify connection status."
- Each sheet's credential field: when `SourceLinkStore` reports the source's secret present, show the field caption "✓ Saved in vault — leave blank to keep" (replacing today's static "leave blank to keep current" copy on Box, generalized to all three). The field stays blank by design (the Mac never holds the secret).

### Warmup
- `LlmIdeMacApp.init()` calls `Task { await SourceLinkStore.shared.refresh() }` after the API client/session is wired (alongside `KeychainStore.warmSessionCache`). The `ConnectionsSettingsSection` also calls `refresh()` on `.task`/appear so the badges are fresh when viewed. Sheets call `refresh()` after a successful save or disconnect so the badge updates immediately.

### No keychain change
Connector secrets stay in the server vault. `KeychainStore` remains app-tokens-only. The vault already provides the persistence across re-login/rebuild/reinstall that "auto-link via keychain" was aiming at; a local keychain copy would diverge from the server-side model for no gain.

## Data flow (the zero-re-entry guarantee)

1. **First-time setup (unchanged):** user fills a sheet, the secret is POSTed to the vault via `setSecret`; non-secret config saved to `AppConfig`. `SourceLinkStore.refresh()` runs → badge flips to **Connected ✓**.
2. **Re-login / rebuild / reinstall on the same Mac:** the vault still has the secret (per-user, server-side; logout doesn't purge it) and `AppConfig` still has the config (UserDefaults survives rebuild/reinstall on the same Mac; re-login keeps it). On launch, `SourceLinkStore.refresh()` detects the secret → badge shows **Connected ✓** — **no re-typing.** The user clicks Fetch (or Auto-Tasks does) to pull data.
3. **Disconnect:** sheet's disconnect clears the vault secret (`setSecret(..., "")`) and (today) the local config; `refresh()` → badge reverts to **Not configured** / **Credentials needed**.

## Error handling

- `fetchSecretKeys()` failure (offline, server down, 401): `SourceLinkStore` keeps the last-known `presentKeys`, sets `lastRefreshFailed`, badges show "—". Never a false "not connected," never blocks the sheets (they still `setSecret` directly).
- A 401 specifically triggers no special action here — the existing session/auth flow handles re-auth; `SourceLinkStore` just reports unknown until the next successful `refresh()`.
- The Mac never receives or stores secret **values** — only the set of keys. No new secret surface.

## Testing

- **Server (likely already covered; add if not):** `GET /auth/me/secrets` returns only the keys currently set (with `updatedAt`), never values; `available` is the full `VAULT_KEYS` allowlist. Assert a user with `slack.botToken` set sees it in `secrets` and **not** its value.
- **`SourceLinkStore` unit (Mac):** inject a `Set<String>` of present keys + a mock `AppConfig` state; assert `isLinked` returns the correct `LinkState` for each of the 3 sources across all states (linked / credentialsNeeded / notConfigured), including the Google-OAuth alternative key for Email.
- **`fetchSecretKeys` decode (Mac):** decode the real `{secrets, available}` JSON shape into the typed list.
- **Manual (success criterion):** connect Slack (or Email/Box) → confirm badge = **Connected ✓** → log out → log back in (same user) → badge shows **Connected ✓** with no re-typing, and a Fetch works.
- (No GUI automation required; the link-state logic is unit-testable; the badge is verified manually.)

## Out of scope (YAGNI / deferred)

- **Cross-device auto-link** (syncing non-secret config to the server so a brand-new Mac is zero-setup) — bigger; needs a per-user connector-config store on the server.
- **Unify the three bespoke sheets** via the `SourceConnectorManifest` generic framework (`mac/.../SourceConnectors/`) — clean long-term, but redesigns forms beyond this goal.
- **Promote Connections out of the collapsed Settings subsection** (less-buried UI) — a separate UX concern.
- **OAuth for Box and Slack** (one-click, like Email's Google button) — provider setup heavy; separate effort.
- **Auto-fetch on launch** — explicitly not wanted; link state only.
- **Moving connector secrets into the macOS keychain** — the vault already provides the needed persistence; no second copy.
