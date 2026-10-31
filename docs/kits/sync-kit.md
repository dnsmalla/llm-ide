# sync-kit

Status: **K0 Map**, written 2026-10-31. No code was changed. Citations are paths and `path:line` where a line was read; read on 2026-10-31 at `main` (`de8d51e8`). Counts say how they were taken (`wc -l`, `find`, `ls`, grep). Section 9 lists where the migration plan's premises do not match the code; section 10 lists what was not verified. The relay itself is designed in [the relay design](../superpowers/plans/2026-10-31-relay-design.md); this page maps what exists today.

## 1. Purpose

sync-kit is how **the phone (and later any browser) reaches the system**. Today that is Mobile Control: a WebSocket server inside the Mac app, Bonjour discovery, PIN pairing, and the native iPhone client. The target (ADR 0018, plan kit 10) replaces it with a **relay** plus a phone web view (PWA), so the phone works with the Mac off. sync-kit is last in the kit order because it **mirrors every other kit**: each kit's screens and requests reach the phone through it.

The plan row (kit 10) names: Mobile Control to relay plus phone PWA; `Features/MobileControl`, `ios_app/SharedProtocol`; key `mobile_sync`; contract group "relay (new)"; depends on every kit it mirrors; K3 after their screens. User decisions (MASTER-PLAN S3 and S4): the phone through the Mac is enough for now (Q-WEB-3); the relay-served phone web view is built **last, in sync-kit** (Q-WEB-1 = A); relay hosting is decided later (Q-WEB-2).

## 2. Code on every side

### 2a. Server (Node)

**None for sync today.** The phone reaches the Node server only through the Mac: the Mac's `MobileControlManager` proxies chat and everything else to `http://127.0.0.1:3456` (`MobileControl/CLAUDE.md` architecture). There is no `relay/` folder (MASTER-PLAN S4) and no route group for `mobile_sync`; the plan's invariant 2 lists it among keys with no server routes.

### 2b. Mac app (Swift, `mac/Sources/LlmIdeMac/`)

| Piece | Path | Lines (`wc -l`) |
|---|---|---|
| Manager (dispatch, backend proxy, capability list) | `Features/MobileControl/Services/MobileControlManager.swift` + `+BridgeHost.swift` | 1 857 + 205 |
| WebSocket server (`NWListener`, default `:3006`, rebinds up to +9) | `MobileWebSocketServer.swift` | 710 |
| Discovery | `MobileBonjourAdvertiser.swift` (`_llmide._tcp`), `MobileConnectionInfo.swift` | 44 + 117 |
| Pairing and auth | `MobilePin.swift` (6-digit PIN in the Keychain, account `mobile::pin`), `MobilePairedDeviceStore.swift` (per-device token, SHA-256 hash on disk, max 20 devices, 30-day idle expiry), `PairingThrottle.swift` | 151 + 197 + 149 |
| Phone access switches and redaction | `PhoneAccessSettings.swift` (11 switches, default OFF for writes), `PhoneRedaction.swift`, `MobileLogPolicy.swift` | 104 + 77 + 57 |
| Bridges | `MobileExploreBridge`, `MobileExploreIndexStore` (453), `MobileWorkspaceSearch` (238), `MobileGenerationBridge` (231), `MobileSelfHealBridge` (330), `MobileUsageBridge`, `MobileIssuesBridge`, `MobileProjectBridge`, `MobileActivityBridge`, `MobileSourceControlBridge`, `MobileFilesBridge`, `PhoneGit`, `PhoneFiles`, `PhoneIssues`, `LlmDocBrowser`, `MobileSkillCatalog`, `MobileToolApproval`, `MobilePhoneToolBridges` | — |
| UI | `Views/MobileControlSettingsSection.swift` (pairing, QR, device list, Revoke) | 707 |
| **Total** | `Features/MobileControl/` (31 files, `find` + `cat \| wc -l`) | **6 976** |
| Bridges owned by other kits | `Features/AutoTask/Services/MobileAutoTaskBridge.swift` (579), `Features/Loop/Services/MobileLoopBridge.swift` (465); chat through `Features/Chat/Services/ChatMobileHost.swift` | — |
| Contracts | `Core/Contracts/MobileFeatureBridge.swift`, `MobileBridgeHosting.swift`, `MobileChatHosting.swift`, `MobileAutoTaskMessages.swift`, `MobileLoopMessages.swift` | — |

### 2c. Extension

None for sync. Under the target the extension reads snapshots and queues requests through the relay when the desktop is off (MASTER-PLAN S4); no code exists.

### 2d. Wire and phone app

| Piece | Path | Count |
|---|---|---|
| Shared wire types | `ios_app/SharedProtocol/Sources/SharedProtocol/` (20 files: Activity, Approval, AutoTask, AutoTaskSetup, Connection, ExploreSkill, ExploreWorkspace, Explorer, Files, Generation, Issues, LlmIdeChat, Loop, MacStatus, MobileProtocol, Project, SelfHeal, SourceControl, ToolApproval, Usage messages) | 2 168 lines |
| Tags | `MobileProtocol.swift` constants (about 90 message types: chat, explorer, auto-task, loop, generation, files, issues, scm, tool approval, self-heal, project, usage, activity, `mac_status`, `mac_capabilities`) | — |
| iOS client | `ios_app/MyApp/` (Services: `ConnectionService`, `ConnectionStore`, `DeviceDiscovery`, 14 stores; Views: Control (19 screens incl. `QRScannerView`), Auth, Settings, Tabs) | — |
| Tests | `ios_app/SharedProtocol/Tests/SharedProtocolTests/` (5 files, 60 `func test` by grep: `MobileProtocolTests`, `ConnectionMessagesTests`, `ApprovalMessagesTests`, `GenerationMessagesTests`, `LoopMessagesTests`); `make test-shared-protocol` | 60 tests |

### 2e. Feature key `mobile_sync`

Excluding it removes `Features/MobileControl/` and the `SharedProtocol` product dependency (`mac/Package.swift`; `build-mac-min`, `build-mac-lite`, `build-mac-mobile-only` quadrants in the `Makefile`). The Auto Task and Loop bridges compile with `auto_tasks` even when `mobile_sync` is out, so they see the manager only through `MobileBridgeHosting`, which owns the wire mapping. Test files naming mobile-only types are in `mobileTestExcludes`.

### 2f. Tests and gates

| Side | Files |
|---|---|
| Mac | 33 files by name (`ls \| grep -ci "mobile\|phone\|pair"`): `MobileControlPortTests`, `MobileWebSocketServer{Bind,Rebind,Routing}Tests`, `MobilePairingFrameTests`, `MobilePairedDeviceStoreTests`, `MobilePairedDeviceExpiryTests`, `PairingThrottleTests`, `MobilePinValidationTests`, `MobileToolApprovalTests`, `MobilePhoneApprovalHookTests`, `MobileHardeningTests`, `MobileFeatureBridgeTests`, `MobileExplore*Tests`, `MobileLoop*Tests`, `MobileSelfHealBridgeTests`, `PhoneGitTests`, `PhoneIssuesTests`, … |
| iOS | `SharedProtocolTests` (60 tests) |
| Gates | invariant 7 of the kit plan: `make build-mac-mobile-only`, `make test-shared-protocol`, the Mobile test files; `mac/Scripts/feature-boundaries.sh`; `docs/mobile/verification.md`; `scripts/mobile/verify-native-pairing.swift` (loopback pairing check, per the Mobile CLAUDE.md) |

## 3. Cross-kit edges

| # | From to | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| E1 | MobileControl to agent-kit (Chat) | `chatHost: MobileChatHosting`, `MobileChatTurnEngine` | C | `Core/Contracts/MobileChatHosting.swift` |
| E2 | to automation-kit | `MobileFeatureBridge`, `MobileBridgeHosting` | C | `MobileControl/CLAUDE.md` |
| E3 | to work-kit (Issues) | `MobileIssuesBridge` over `Core/Repo`; `RecentIssuesProviding` | C | `IssueSeams.swift` |
| E4 | to docs-kit | `GenerationProviding` seam | C (resolved) | docs-kit map E9 |
| E5 | to workspace-kit | files, git, search bridges over Core types | C (Mac only) | workspace-kit map E6 |
| E6 | to knowledge-kit | `ProjectNotesProviding`, `LlmDocBrowser` reads `llm-doc/` | C | `Core/Contracts/ProjectNotesProviding.swift` |
| E7 | to graph-kit, os-kit | activity and usage state (`MobileActivityBridge`, `MobileUsageBridge`) | C | bridge files |
| E8 | to Settings | `SettingsSectionRegistry` card | C | `MobileControlSettingsSection.swift` |
| E9 | iOS app to server | none direct; always through the Mac | rule | data-lifecycle ("the phone reads through the Mac") |

**Cycles:** none found; MobileControl is sealed and names no other feature. **Key property:** every other kit that wants a phone surface adds a bridge and wire tags, so sync-kit's contract grows with every kit; this is why it goes last.

## 4. Delegated vs owned

| Piece | Label | Reason |
|---|---|---|
| Transport (WebSocket, Bonjour) | Owned (platform) | Replaced by the relay in the target. |
| Pairing, per-device tokens, revocation, idle expiry, throttle | Owned | Permission: the center of the security design. |
| Phone access switches, handler re-check, typed refusals | Owned | Permission. |
| Redaction (`PhoneRedaction`) | Owned | Permission and privacy. |
| Chat on the phone | Delegated | It is agent-kit's engine; the phone is only a client. |
| Explorer search index for the phone (`MobileExploreIndexStore`) | Owned | Knowledge slice for the phone. |
| Wire types (`SharedProtocol`) | Owned | Contract; versioned. |
| iOS app and the PWA | Owned UI | K3 equivalent: the PWA from ui-kit. |

## 5. State and data (feeds K1a)

- **Mac:** PIN in the Keychain (`mobile::pin`); paired device registry `MobilePairedDeviceStore` (JSON in Application Support, token **hash** only, `pairedAt`, `lastSeenAt`); phone access switches in UserDefaults (`mobile.phoneAccess.<name>`); explore index store.
- **Phone:** the device token in the iOS Keychain; last-known state in `Services/*Store`.
- **Server:** none for sync.
- **Relay (target):** none exists. The design is in the relay design doc: encrypted snapshots and an inbox; no plaintext, no LLM calls, no code execution on the relay.
- **One-copy rule:** a snapshot is **not** a second store of record; it is an encrypted, replaceable read view of the desktop's data (data-lifecycle rule 1 reading, to confirm with the user, relay question R1).

## 6. What K1 would move (proposal)

Not "move": **replace**, per ADR 0018 ("replaced, not ported"). In order:

1. **K0 (this map)** and the relay design doc.
2. **Spec the relay contract** into `schema/http` (group "relay (new)"): snapshot put/get, inbox put/drain/ack, device enroll/revoke, with conformance fixtures; the encrypted envelope formats in the design doc.
3. **Snapshot producer and request consumer** in the Node core (desktop side): a producer that renders each mirrored kit's read view to a snapshot, and a consumer that drains the inbox and re-checks permissions locally before running anything.
4. **Relay service** (code starts here, never before the Phase 0 closing items, per MASTER-PLAN).
5. **Phone web view** served by the relay, built last, reusing ui-kit components.
6. **Retire** the cleartext `:3006` link and the PIN once the relay reaches parity (ADR 0018 "Supersedes"); the native iOS app stays until PWA parity, then is optional.

The Mac WebSocket path stays **unchanged and working** until step 6 (kit plan invariant 7).

## 7. Decisions needed from the user

The relay questions are in the relay design (decisions D1 to D9 resolved 2026-10-31 by the user's delegation to the secure option, "revisit if wrong"; D6 hosting still open until R2; external review G-EXT before any public exposure). The design was revised to the independent security review. Map-level questions:

| # | Question | Options | Recommended |
|---|---|---|---|
| S1 | Keep the native iOS app after the PWA reaches parity? | keep; retire | **Decided 2026-10-31 (user delegated to the secure option; revisit if wrong): keep, permanently.** The PWA is read-only plus low-risk queueing on a separate origin; writes and approvals stay on the native app and desktop (relay design D1) |
| S2 | While the relay is not built, should phone features keep growing through the Mac (new bridges for new kits), or freeze? | grow; freeze | freeze new phone surfaces: every new bridge is a surface to re-implement on the relay; fix bugs only (still open for the user, unchanged by the review) |
| S3 | Is "the phone through the Mac is enough for now" (Q-WEB-3) still true for the **extension** when the Mac is off? | yes; no | yes: the extension keeps its local-core mode; remote mode is a later phase and is **meeting upload only, no snapshot keys** (D7, delegated 2026-10-31) |
| S4 | Should the relay carry **all** wire tags or only a read and request subset first (chat read, approvals, activity, usage, auto-task and loop status)? | all; subset | **Decided 2026-10-31 (delegated; revisit if wrong): subset.** Reads per capability set; queued while the desktop is off: chat prompts, activity-seen, phone-session project switch, all under a fixed read-only ceiling (D2); approvals live-only on native; writes native or desktop only |
| S5 | Delete the PIN pairing once QR enrollment exists, or keep the PIN as a fallback on the LAN? | delete; keep | **Decided 2026-10-31 (delegated; revisit if wrong): delete** with `:3006` at R9 (cleartext and PIN go away, ADR 0018 consequence); the Mac path stays until parity |
| S6 | Who may enroll a device: the admin only, or any signed-in user for their own devices? | admin; user | **Decided 2026-10-31 (delegated; revisit if wrong): each user enrolls their own devices; per-user keys with individual login, no key shared between people (D8).** A team is a later, separate cryptographic design. Enrollment needs the QR secret, SAS on both screens and desktop confirmation |

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | The wire contract grows with every kit (about 90 tags, 20 files) | Freeze new surfaces (S2); the relay carries a versioned subset |
| R2 | Cleartext `ws://` on the LAN today: a sniffed token works until the 30-day idle expiry | Already mitigated (idle expiry, rotation, per-device tokens); retire at relay parity |
| R3 | A phone holding an old capability list calls a removed bridge | Handlers re-check on every request and return typed refusals (existing rule) |
| R4 | Port `:3006` conflicts with a foreign process answer "Wrong PIN" (memory note) | Bind-with-fallback exists; relay removes the port |
| R5 | Security: first public service in the product | Relay design threat model (T1 to T23); E2E with per-kind subkeys; tiered clients; external review gate before public exposure |
| R6 | Two phone paths during the overlap double maintenance | Time-box; the Mac path is frozen |

## 9. Drift, gaps and corrections to the plan's premises

1. The plan lists `Features/MobileControl` as 7.0 k lines; counted 6 976 (matches). The AutoTask and Loop bridges (1 044 lines) are **outside** that folder, in other kits.
2. The plan says the relay's contract group is "relay (new)"; **no schema, route or fixture for it exists**.
3. The kit plan's invariant 7 ("the phone keeps working through the Mac until sync-kit lands") is enforced by build targets and tests, not by a live phone test.
4. MASTER-PLAN S3 said "no sync-kit K0 map"; this page is that map.
5. `docs/mobile/quick-start.md` and `verification.md` exist (referenced by the Mobile CLAUDE.md); not re-read here.

## 10. What I could not verify

- Any run-time behaviour: no phone, no WebSocket session, no `swift test`, no `make test-shared-protocol` was run.
- The exact count of wire tags (about 90 by reading the constants; not grep-counted).
- Whether the iOS app has its own test target beyond `SharedProtocolTests` (not searched).
- The real-device pairing flow and push behaviour (needs the user, MASTER-PLAN `(you)`).
