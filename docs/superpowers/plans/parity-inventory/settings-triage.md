# Settings parity triage (verified)

Scope: the 100 Mac Settings labels the parity inventory (`scripts/parity-inventory.mjs`) found missing from the desktop (agent history, Agent SDK, backend, feature profile, provider forms and sections, routing, preferences, optional components, Self-Heal, token saving, tool approvals, updates). Two Haiku passes classified them (g07, g08); this is an independent Opus pass that re-read the Swift, the desktop UI, the Tauri host and the core. Per-label results: `settings-verified.json` in the session scratchpad (same schema plus `verifiedBy`, `changed`, `verifyNote`, `batch`).

Method: every REAL_GAP and MAC_ONLY was re-checked for reachability on the Mac and absence on the desktop (grep with synonyms, plus `desktop/src-tauri/src` and `extension/`). 45 of 48 final REWORDED labels were opened at the cited desktop file:line; all RUNTIME labels were checked.

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REWORDED | 50 | 48 |
| REAL_GAP | 24 | 23 |
| MAC_ONLY | 19 | 22 |
| RUNTIME | 7 | 7 |
| DEAD_ON_MAC | 0 | 0 |

10 labels changed (5 class changes, 5 corrections of needs/risk/evidence). In feature terms, 9 Haiku claims were overturned or materially corrected (listed below). Every Settings view involved is live on the Mac: `SettingsView.swift` renders Backend (:39), Agent SDK, Providers, Model routing, the feature slots (Agent history is registered at `FeatureCatalog.swift:144`), Optional components and Self-Heal (:68-70, source checkouts only). Nothing here is DEAD_ON_MAC.

## Reclassifications and corrections

1. **Plain-http refusal (g08, 1 label): this is not a security enforcement gap.** Haiku's premise was that once the private-network box is ticked, a public `http://` address gets through. The client does pass it on, but the core refuses it. What each layer enforces:
   - Core (authoritative): `extension/server/base-url-guard.mjs:56-75` allows `http:` only when `allowPrivate` is on AND the host is a private, loopback, CGNAT or ULA IP literal, or a `localhost`/`.local` name. Public hosts must use https in every mode. `allowPrivate` is honoured only when the catalog entry allows it, the user opts in, and the operator gate `privateProvidersAllowed()` (:32-37) is open (`provider-connections.mjs:172-186`). The check runs again on every dispatch (`provider-connections.mjs:231`), and DNS is pinned at connect time (`pinned-fetch.mjs`).
   - Desktop client: `validateConnect` (`ui/screens/settings/providers-model.ts:184-200`) only requires the box to be ticked for http. The Edit path (`providers-model.ts:407-425`) runs no client check at all. A public http address therefore fails at the core with the generic message (`describeClaudeConnectError`, :142-147) instead of a clear warning.
   - Mac client: `EndpointSecurity.isInsecureRemoteHTTP` (`ProvidersModel.swift:412-416`) refuses http to anything except loopback, **including LAN/RFC1918 hosts even when the user has opted in**, and blocks Save in both forms (`ProviderForms.swift:59, 157, 212-215`).
   - Result: REAL_GAP, ui, S, not risky (Batch A): mirror the core rule on the client in both Add and Edit, and show the Mac's "your API key would be sent unencrypted" sentence. The stricter Mac LAN rule is a product decision (Batch C). I recommend keeping the core's posture, which supports a LAN Ollama, and not copying the Mac rule.
2. **Server URL editing + Relaunch Now (g07, 2 labels): REAL_GAP changed to MAC_ONLY, intended divergence.** On the Mac, saving the URL signs the user out, deletes the Keychain token and asks for a relaunch (`BackendSettingsSection.swift:75-111`). The desktop is built never to talk to an unverified external core in a release build: `core_host.rs:1-18, 62, 105-111` (adopt only with `LLMIDE_ADOPT_CORE=1`; release CSP). The developer need is already covered by the source-checkout Server URL/port in `ServerSection.tsx` (BackendForm). This is HOLD: porting it would undo a security design and involves sign-out and tokens.
3. **Shared legacy endpoint "Save URL" (g08, 1 label): REAL_GAP changed to MAC_ONLY.** The vault `custom.baseUrl` and `custom.apiKey` pair belongs to the retired classic engine. The core moves it into a catalog connection (slug `legacy`) once, on the first `GET /kb/providers/catalog` (`legacy-key-migration.mjs:6-11, 88-91`), and the desktop already makes that call. Writing a vault URL from the desktop would bring back a store that has been replaced.
4. **"API key for" / "Save key for" (g08, 2 labels): REWORDED changed to REAL_GAP (HOLD).** Haiku covered only catalog connections, which the desktop re-keys by reconnecting. On the Mac, the same per-row key field (`ProvidersSection.swift:249-263`) also serves the built-in credential rows (`ProviderCatalog.swift:48-85`):
   - the **Anthropic API key** (`claude.apiKey`, the per-user key `runClaude()` prefers);
   - the **Jev** decisions key (API v73+);
   - the optional **SerpAPI** key.

   No desktop file mentions any of the three (only a test fixture). The route already exists: `POST /auth/me/secrets` with allowlisted keys (`vault.mjs:141-158`), already used write-only by `RepositoriesSection.tsx:108`.
5. **Legacy key notice (g08, 1 label): needs corrected from core M to ui S.** The Mac takes this from the key names returned by `GET /auth/me/secrets` (`LlmIdeAPIClient+Providers.swift:52-56`, `ProviderRows.swift:147-161`). The desktop already calls that route (`RepositoriesSection.tsx:67`). Names only, never values.
6. **Restart confirmation (g07, 2 labels): evidence corrected.** Only the Agent SDK card's Restart backend button (`AgentSdkSection.tsx:36-48`) lacks the Mac's confirmation. The Mac's own Kill & Restart (`BackendSettingsSection.swift:180-183`) has no confirmation either, so desktop `ServerSection.tsx:113` is at parity.
7. **SDK update auto-restart (g07): risky corrected to true.** The change is pure UI (`host.coreRestart` exists), but it stops running chats and Loop runs, so it must ship with the confirmation copy.
8. **Move to catalog (g08, 3 labels): stays REAL_GAP, scope reduced.** Two things already cover most of it:
   - The desktop Add form copies the stored openai/google/deepseek key on the server (`ProvidersSection.tsx:152-153`).
   - The core's one-time migration creates connections for built-in keys, `custom:<id>` and the shared endpoint (`legacy-key-migration.mjs:59-97`).

   `copyKeyFrom` already accepts `custom` and `custom:<id>` (`legacyKeyFor`, :124-134). What remains: the desktop cannot list the Mac's OpenAI-only custom providers (`GET /kb/providers/custom` returns only the Anthropic-door ones, `provider-catalog.mjs:66-73`), so this needs a read-only core route. Low value.
9. **Claude-compatible model list (g08): confirmed, with nuance.** The Mac's Claude-compatible form writes to the Mac-local custom list (`ProviderForms.swift:4-7, 274-282`, synced by `POST /kb/custom-providers`). Core connections carry `models: []` (`provider-connections.mjs:234`), so typed model ids need a new core field.

Confirmed as Haiku stated: Self-Heal (12 labels) is MAC_ONLY. The card is live only on a source checkout (`SettingsView.swift:68`, `AppSourceRoot.gitRoot`). Capture is OSLog, crash reports and stderr, and proposals are git worktrees. No incident code exists in `extension/` (grep: no route, no store); `notices.ts:34-38` and `groups.ts:47` already mark it mac-only. Porting it would not be small: it needs host log capture plus worktree management. The Mac-local custom provider list (6 labels) and "Make Standard the default" (Mac UserDefaults legacy defaults, `AppConfig+TierDefaults.swift:37-60`) are also MAC_ONLY.

## Feature table (one row per card/control)

| Feature | Final class | Labels | Evidence | Missing / needs / effort / risky / safe now |
|---|---|---|---|---|
| Agent history: last cleaned per group | REAL_GAP | 1 | decoded (`decoders.ts:330`), not rendered (`AgentHistorySection.tsx:27-33`) | show date under clearable groups; ui S; no; yes (A) |
| Agent history: store health summary (dropped rows, raw/rolled days, reset after damage) | REAL_GAP | 2 | `agentHistory` object (`agent-history-api.mjs:162-170`) dropped by `decodeStorageReport` | decode + 2-3 lines; ui S; no; yes (A) |
| Agent history: store down notice | REWORDED | 1 | banner `AgentHistorySection.tsx:37`; no "restart the backend" advice | optional wording |
| Agent history: load error | REWORDED | 1 | `ErrorText` :22; no Retry (focus refresh) | optional Retry |
| Chat archive mode + off confirm | REWORDED | 3 | radiogroup :121-137 | - |
| Chat archive: "still running with X" | REAL_GAP | 1 | launch mode read at :110, not printed | ui S; no; yes (A) |
| Agent history clear scope/sheet | REWORDED | 6 | :49-50, ClearSheet :58-97 | "Runs in progress are kept" sentence missing from `scopeSentence` |
| Agent SDK: check error, progress | REWORDED | 2 | `AgentSdkSection.tsx:30, 55` | - |
| Agent SDK: restart backend after update + its warning | REAL_GAP | 2 | `app-model.ts:142-155` never restarts; Mac `AgentSdkSettingsSection.swift:148-152` | restart + wait-for-version after confirmed update, fix confirm copy; ui S; yes (stops chats); yes (A, after the confirm row) |
| Agent SDK: Restart backend confirmation | REAL_GAP | 2 | `AgentSdkSection.tsx:36-48` restarts immediately | confirm dialog naming the stopped chats/Loop runs; ui S; no; yes (A) |
| Server URL editing (external server) | MAC_ONLY | 2 | desktop design `core_host.rs:1-18,105-111` | HOLD: intended divergence |
| Backend paths save | REWORDED | 1 | `ServerSection.tsx:233-238` | - |
| Backend pid, log line count | RUNTIME | 2 | decoration | - |
| Backend log follow / auto-scroll | REAL_GAP | 1 | snapshot `<pre>` `ServerSection.tsx:121-123` | poll `host.coreLog` while open + stick to bottom; ui S; no; yes (A) |
| Home page choice | REWORDED | 1 | `SimpleSections.tsx:53` | no "(hidden)" marker |
| Build: confirm, apply, stale rebuild | REWORDED | 3 | `BuildSection.tsx:86-96` | - |
| Build: staged build + explicit Restart & Install | REAL_GAP | 1 | `feature_rebuild.rs:1-5`, `rebuild-desktop-features.sh:50-60` auto-swaps | split script + host command; rust M; no; C |
| Help guide close | REWORDED | 1 | `WelcomeScreen.tsx:49`, `Shell.tsx:163,253` | - |
| Project memory empty state, files | REWORDED | 2 | `project-model.ts:116-123` | - |
| Routing: Standard tier hint, unavailable provider, fallback reorder | REWORDED | 4 | `routing-model.ts:10`, `RoutingSection.tsx:44, 118-119` | - |
| Routing: "(catalog)" tag | RUNTIME | 1 | decoration | open question: Mac hides catalog connections (and Jev) from Standard (`ModelRoutingSection.swift:174-186`), desktop lists them; not verified whether the core cares |
| Make Standard the default | MAC_ONLY | 1 | Mac UserDefaults (`AppConfig+TierDefaults.swift:37-60`) | - |
| Routing: provider-settings load error | REAL_GAP | 1 | `RoutingSection.tsx:83-84` shows "Connect a provider" on a failed load | show `p.error` + Retry; ui S; no; yes (A) |
| Routing: key-migration notice + "Turn on the session router" | REAL_GAP | 1 | `migration` sent at `provider-catalog.mjs:88-90`, never decoded | decode, tools hint, router button via `host.setRoutePrefs`, list `needsReview`; ui S; no; yes (A) |
| Add provider type / catalog picker | REWORDED | 2 | one select `ProvidersSection.tsx:123-128` | - |
| Catalog connect form (URL, short name, private box) | REWORDED | 3 | `ProvidersSection.tsx:136-151` | - |
| Claude-compatible help text | REWORDED | 1 | ClaudeLimits | - |
| Claude-compatible typed model list | REAL_GAP (+1 RUNTIME placeholder) | 1+1 | connections carry `models: []` | core field on anthropic-compatible connection + UI; core M; no; C |
| Plain-http warning (client-side mirror of the core rule) | REAL_GAP | 1 | see reclassification 1 | ui S; no; yes (A, first) |
| Mac-local custom provider list (unreadable list, discard) | MAC_ONLY | 6 | Mac UserDefaults store | - |
| Add provider entry, remove confirmation, key badges | REWORDED | 4 | `ProvidersSection.tsx` toolbar, pendingRemove, `secret-field.ts:47-51` | - |
| Legacy key notice per row | REAL_GAP | 1 | key names via `GET /auth/me/secrets` | ui S; no (names only); yes (A) |
| Shared legacy endpoint (Save URL + placeholder) | MAC_ONLY (+1 RUNTIME) | 1+1 | migrated once by the core | - |
| Built-in credential keys: set/replace (Anthropic, Jev, SerpAPI) | REAL_GAP | 2 | no desktop reference; route exists | write-only SecretField rows; ui S; yes (secrets); HOLD |
| Built-in credential keys: clear | REAL_GAP | 2 | `ProviderRows.swift:77`; `POST /auth/me/secrets {value:null}` exists | ui S; yes (deletes a secret); HOLD |
| CLI check | REWORDED | 2 | `BuiltinProviders.tsx:82-84` | - |
| Models show/hide | RUNTIME | 1 | `ProvidersSection.tsx:73` | - |
| Move to catalog | REAL_GAP | 3 | see reclassification 8 | read-only core route listing legacy candidates (no key) + button; core M; yes (key copy); C |
| Tools override per model | REWORDED | 3 | ModelsPanel `ProvidersSection.tsx:226-229` | - |
| Self-Heal card and proposal sheet | MAC_ONLY | 12 | source-checkout gate, OSLog/worktrees, no core incident code | - |
| Menu-bar icon switch | REWORDED | 2 | `GeneralSection.tsx:85`, `misc-model.ts:33-34` | no Quit warning (the desktop tray has no chat popover) |
| Native plugin loading | REWORDED | 1 | `app-model.ts:174-175` | hint omits the trust and MCP-consent sentences; worth adding |
| Mermaid row + remove help | REWORDED | 2 | `components-model.ts:8-13` | - |
| Token saving warning | REWORDED | 1 | `components-model.ts:28-29` | - |
| Tool approvals revoke-all, allowed date | REWORDED | 2 | `ToolPermissionsSection.tsx:26, 45-52` | - |
| Automatic update checks | REAL_GAP | 1 | Mac only when the build sets `LLMIDE_SU_FEED_URL` (`mac/Scripts/build.sh:107-121`); no desktop updater | rust L; yes; C |
| Bundle ID | RUNTIME | 1 | decoration | - |

## Implementation batches

**Batch A: small pure-UI items, safe now (in this order)**
1. Plain-http warning: mirror `assertProviderBaseUrl`'s http rule in `validateConnect` and add it to the Edit path (`providers-model.ts:184-200, 407`), with the Mac's unencrypted-key sentence. Keep the core's LAN posture; add a test that pins the client rule to `base-url-guard.mjs` cases.
2. Routing: show the shared providers-model load error with Retry instead of "Connect a provider" (`RoutingSection.tsx:83`).
3. Routing: decode `migration` (created, needsReview, toolsSuggested); show the tools hint, the "Turn on the session router" button (`host.setRoutePrefs`) and the needs-review list.
4. Agent history: Last cleaned date, the store health summary (raw from day, rolled-up days, oldest day, dropped rows, reset after damage) and "This session is still running with X".
5. Agent SDK: a confirmation before Restart backend that names the stopped chats and Loop runs; fix `SDK_TEXT.restartNote`/`confirmBody` ("restart the app" is wrong now that the button exists).
6. Agent SDK: after a confirmed update, restart the backend and wait for the new version (the Mac's `waitForBackend`). This depends on item 5's copy because it stops running work.
7. Backend log follow: poll `host.coreLog` while the group is open, with an Auto-scroll checkbox.
8. Legacy key notice per provider row, from `GET /auth/me/secrets` key names.
9. Copy-only: native-plugin hint trust/MCP-consent sentences; "Runs still in progress are kept" in the clear sentence (verify in the core first).

**Batch B: UI that needs a small host or core change.** None after verification. The items Haiku tagged core/rust that turned out to be UI-only went to A. The rest need a real route or a decision (C).

**Batch C: Rust/core route or product decision**
- Claude-compatible typed model ids: a `models` field on anthropic-compatible connections in `provider-connections.mjs` plus the connect route; decide whether the chat picker merges typed ids with `/v1/models`.
- Move to catalog: a read-only route listing legacy candidates (OpenAI-only `custom:<id>`, shared endpoint) without keys. Recommendation: skip it, because the one-time migration covers existing users; surface `needsReview` (A3) instead.
- Staged rebuild with explicit Restart & Install: split `rebuild-desktop-features.sh` into build and swap, and add a host command for the swap.
- Desktop updater (tauri-plugin-updater, feed, signing keys): a product and infrastructure decision. Installing code is security-sensitive.
- Plain-http LAN policy: keep the core's (recommended) or adopt the Mac's stricter rule in the core for everyone.
- Standard tier provider list: decide whether catalog connections may drive Standard on the desktop, as the Mac forbids.

**HOLD (secrets, tokens, sign-out)**
- Built-in credential keys (set, replace, clear) for the Anthropic API key, Jev and SerpAPI. Recommendation: build it, because the Anthropic per-user key is a real capability the desktop lacks. Safeguards:
  - reuse the write-only `SecretField`/`SecretInput` (value taken and cleared before the request, never read back);
  - send only the allowlisted keys through `POST /auth/me/secrets`;
  - show only presence from the key names;
  - put Clear behind a typed confirm;
  - add tests that no key value reaches state or logs;
  - get a review of the change by someone other than its author.
- Server URL editing to an external server: do not port. Record it as an intended divergence in the mirror map.

## Stale documentation and code comments found

- `docs/superpowers/plans/2026-10-31-settings-mirror-map.md:35` (Claude Agent SDK): "WORKS NOW (no restart button)", "no host restart command", blocked-by "Host command to restart the core". Wrong: `AgentSdkSection.tsx:35-48` has Restart backend via `host.coreRestart`.
- Same file, :73: the blocked-by summary still lists "restart core + read core log" as host commands to build. Both exist (`core_restart` in `core_host.rs:1230`, `host.coreLog`).
- Same file, :37 (Providers) "WORKS NOW": overstated. Built-in Anthropic API key, Jev and SerpAPI keys cannot be set or cleared on the desktop.
- Same file, :38 (Model routing) and :41 (Agent history) "WORKS NOW / unchanged section": overstated given the Batch A gaps above.
- `ui/screens/settings/notices.ts:63` (`server` partial note): "the editable Node/project paths and server URL do not apply and are not shown". Stale: BackendForm edits them for a source checkout.
- `ui/screens/settings/sections/ServerSection.tsx:15` doc comment: "Starting/stopping the backend by hand is not offered". Stale: Start, Stop and Kill & Restart are at :106-117.
- `ui/screens/settings/app-model.ts:102-103` `SDK_TEXT.confirmBody` and `restartNote` tell the user to restart the app; a backend restart is enough and is offered.

## Not verified

- Whether the core actually keeps in-progress runs on clear (the Mac's "Runs still in progress are kept").
- Whether the core or the desktop chat composer mishandles a catalog connection set as the Standard tier.
- Whether any release Mac build sets `LLMIDE_SU_FEED_URL`; if none does, automatic update checks are not live on the Mac either.
- How the desktop chat picker behaves for a Claude-compatible endpoint whose `/v1/models` is empty.
- Nothing was run in a real window.
