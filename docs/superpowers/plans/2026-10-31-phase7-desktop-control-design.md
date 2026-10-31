# Phase 7 design: desktop and browser control with per-app grants, audit and kill switch

Status: **design revision 2 (incorporates an independent adversarial review). Security first. No code exists and none starts before the research spikes in section 10 (P7.pre) finish and an independent re-review of this revision signs off.** Date: 2026-10-31, at `main`. Inputs read: [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md), the [Tauri plan](2026-10-24-tauri-desktop-and-relay.md) (phase 7 row, section 8, risks), the [relay design](2026-10-31-relay-design.md) (D1, D2, capability tiers, the remote-safe ceiling), the [relay security review](2026-10-31-relay-security-review.md), the [extensions catalog plan and spec](../../spec/extensions-catalog.md), the MCP adapter limits in `extension/providers/adapter/mcp-client.mjs` and the mount policy in `extension/llm_agent/adapter/mcp-mount.mjs`, and the Phase 0 accessibility probe `desktop/src-tauri/src/ax_probe.rs`.

Not verified: every per-OS statement in section 6 that is not backed by the Phase 0 probe comes from general platform knowledge, not from a check against current vendor documentation or a run on that OS. Section 6 says so row by row, and the spikes in section 10 exist to confirm or kill each claim before any code is written. Where this revision corrects the first draft, section 13 maps each review finding to the change.

## 1. Goal and non-goals

**Goal.** Let the desktop agent look at and operate **one app at a time that the user has explicitly granted**, through MCP tools, with the user always able to see it and stop it, and with a record of every action.

**Non-goals for the first release.**

- No unattended driving: Loop, Auto Tasks and scheduled jobs never drive the desktop and a Loop spawned from a driving turn inherits no grant (5.4).
- No driving from a phone or any relay request (5.4).
- No "whole desktop" or "all apps" grant, and no remote-desktop product.
- No credential entry by the agent (4.5).
- No Windows or Linux input injection until macOS has passed its gates.
- No browser tier until the desktop tier has passed final review (section 7).
- No grants for communicating, scripting-capable or browser apps through the desktop path (4.2).

## 2. What is being protected

| Asset | Why it matters |
|---|---|
| Everything the user can do in any granted or reachable app (mail, banking, admin consoles, IDE, terminal) | A driven app acts with the user's identity. |
| Credentials and secrets visible on screen or in the clipboard | One screenshot is a copy. |
| Data in other apps' windows | A screenshot of a display includes them. |
| The audit trail | It is the only way to answer "what did the agent do". |
| The company LLM key and the vault | Reachable if the agent drives a terminal or the app's own settings. |
| The user's attention and trust in the approval UI | Approval fatigue and spoofed dialogs defeat every other control. |

## 3. Threat model

The attacker is **text the model reads**, not a person at the keyboard. The model is treated as an untrusted component that follows instructions found in content (the same stance as the extension mount: tool results are "untrusted data", `fenceToolResult`). The Node core and the MCP shim are in the same trust position as the model: they are processes the model can influence.

| # | Threat | Example | Primary controls (section) |
|---|---|---|---|
| T1 | **Prompt injection drives the desktop** | A web page, mail, document, notification, window title or hidden node in the granted app says "open Terminal and run ...". | Per-app grant (4.1); no shell or network tools in a driving turn (5.2); app-category exclusions (4.2); taint by origin (5.3); hidden-node filtering (4.8); action classes (4.3). |
| T2 | **Confused deputy** | The user grants "Notes"; the agent uses its share sheet or link handlers to reach mail or a browser. | Grant bound to app identity and windows; focus change pauses; handoff class always approved with local-presence proof (4.3, 4.9). |
| T3 | **Data exfiltration through screenshots and trees** | A screenshot of a password manager or private chat goes to a cloud provider. | Window-scoped capture; tree-only to cloud providers by default; no content through relay, logs or replay buffers (5.5). |
| T4 | **Credential entry and capture** | The agent types a password it saw, reads a secure field, or is shown a system security prompt. | Secure fields never read or written; system security UIs auto-pause; post-pause redaction (4.5). |
| T5 | **Destructive or irreversible actions** | "Delete", "Send", "Pay", `rm`, a form submit, Return on a default button. | Fail-closed classifier by focused element and role; never-overridable categories; local-presence approval (4.3, 4.4, 4.9). |
| T6 | **Grant escalation and approval spoofing** | The approval dialog is driven, occluded, imitated by an overlay, or worn down by repetition. | Shell-owned trust anchor, occlusion refusal, minimum display time, HID-source check, batching rules, rate limits (4.9). |
| T7 | **Runaway or looping agent** | Thousands of clicks, a held key, a drag that never ends, a grant-request spam loop. | Global budgets, repeated-action detector, atomic input events, watchdog release (4.6, 4.10). |
| T8 | **Tampered or silent audit** | The model or malware removes the trail. | Hash-chained log with honest limits (4.7). |
| T9 | **Malicious or compromised MCP tool server** | A third-party "desktop" MCP server is installed and asked for a grant. | Reserved names, distinct built-in mount keyed on signed shim identity and per-turn token (5.1). |
| T10 | **Remote request starts driving** | A queued phone or relay request "open this and click that". | Fixed read-only ceiling; remote-queued text in a turn bars `desktop.*` (5.4). |
| T11 | **Local malware or another process calls the driver** | A process on the machine talks to the socket. | Authenticated per-turn-token socket owned by the shell, OS-user bound (5.1). |
| T12 | **TOCTOU between approval and action** | The user approves "click Send" and the screen changes. | Act on AX element reference, re-resolve and re-check per action, snapshot ids tied to grant and turn (4.4, 5.6). |
| T13 | **Kill switch fails open** | Hotkey not registered, Node frozen, driver killed mid-drag, keys left held. | Fail-safe design in 4.6. |
| T14 | **Cost and budget exhaustion** | A driving turn burns tokens on a loop. | Per-grant turn, token and cost caps (4.10). |

Out of scope: a fully compromised OS account, a malicious OS, hardware attacks. Residual risk in section 11.

## 4. Grant model

### 4.1 The grant

A grant is a record held **only by the one trusted Rust process** (the shell, 5.1), never in the Node core's database and never writable by the core.

| Field | Meaning |
|---|---|
| `grantId` | Random, shell-minted. |
| `app` | The app's identity: macOS bundle id plus code-signing team id; Windows executable path plus Authenticode signer; Linux desktop-file id plus executable path. A different binary with the same name does not match. |
| `windows` | The window handles the grant covers (the app's windows at grant time, plus new windows of the same process only when the user ticked "include new windows"). |
| `classes` | The set of action classes (4.3). |
| `expiresAt` | Expressed as a **monotonic** deadline (not wall clock), so a clock change or NTP step cannot extend it. |
| `idleExpireMs` | Default 5 minutes without an action, monotonic. |
| `maxActions`, `maxTurns`, `maxTokens`, `maxCostUsd` | Budgets (4.10). |
| `createdBy` | `local-user` only. Any other value is invalid. |
| `osUser`, `coreUserId` | The OS account and the core user the grant is bound to; a mismatch on either voids it. |
| `turnId` | The chat turn that asked. A grant does not carry to another turn or session. Two simultaneous turns cannot share or both hold grants for the same app. |

Rules:

- **One grant per app, per turn.** There is no wildcard and no "any app".
- **Grants are not persisted across a shell restart.** A shell restart loses all grants by design (tested). Sleep, screen lock, lid close and fast-user-switch revoke them; monotonic time is compared against wake, so sleeping through an expiry never resurrects a grant.
- **Focus rule.** If the frontmost window is not covered by the grant, every driving call fails closed with `not_granted_focus` and the indicator turns amber. The agent may ask the user to bring the app forward; it cannot raise another app itself.
- **Secure event input** (macOS) or a system security UI in front pauses the grant (amber) and **drops every cached snapshot**; resumption re-snapshots (4.5).
- **Request flow.** The model calls `desktop.request_grant({ app, classes, reason })`. This does nothing but ask. The **shell** shows a native, non-webview dialog (4.9) naming the app, the classes in plain words, the duration and the reason text (clearly marked as the agent's words, length-capped, stripped of hidden characters). Only a physical click on **Allow** creates the grant. Default focus is **Deny**.
- **Request spam.** `request_grant` is rate-limited (at most 3 requests per turn and 6 per 10 minutes globally), backs off exponentially after each deny, and **locks out** after 3 consecutive denies in a turn until the user re-enables from the shell UI. Denied and timed-out requests are logged.

### 4.2 Grantable categories and the never-overridable list

First-release grantable app categories are deliberately narrow. **Not grantable in the first release:**

- mail and calendar clients, chat and messaging apps (communicating apps);
- browsers through the desktop path (the browser tier is separate, section 7);
- scripting-capable apps: IDEs, terminals and shells, Office suites with macros, automation tools, anything with a plugin or script host;
- password managers, the OS keychain and credential UIs, OS settings and security panes, system permission dialogs, this app itself, remote-desktop and VPN clients.

**Never overridable, by app and by origin** (cannot be unlocked by any setting or approval): payments, banking, trading, tax, government services, health records, account recovery, 2FA setup, and admin or cloud consoles. The category list is data in the shell, shown in Settings, user-extensible, never user-shrinkable below the built-in set in the first release.

What remains is notes, text editors without script hosts, document viewers, and similar bounded apps, which is a small but real first use case set. An app not matched to a known profile is "unclassified" and follows the unclassified default in 4.4.

### 4.3 Action classes

| Class | Examples | Grant covers? | Approval per action |
|---|---|---|---|
| `observe-tree` | read the app's accessibility tree, element names and values (not secure fields) | yes | no |
| `observe-screen` | a screenshot of the granted window; **higher risk than observe-tree** | yes, separate tick | no, but provider rules (5.5) apply |
| `navigate` | scroll, move focus, switch tabs, expand, select (no state change) | yes | no |
| `input-benign` | type text into a non-secure field, press non-destructive keys (classified per 4.4) | yes | no |
| `invoke` | press a button or menu item that is not classed destructive | yes | **first use per grant, then no** |
| `clipboard` | read or write the clipboard | separate tick | yes per action; concealed pasteboard types fail reads |
| `handoff` | open a URL, open-with, share, drag a file out of the app, reveal in a file manager | separate tick | **always, with local-presence proof** |
| `destructive` | delete, send, post, submit, pay, transfer, quit without saving, empty trash, permission or settings change, uninstall, any scripting, macro, shortcut or plugin menu item, anything the classifier cannot rule out | never in a grant | **always, live, on the desktop, with local-presence proof** |
| `credential` | type or read a secure field, autofill, a keychain prompt | never | **never** (the agent stops and asks the user to do it) |

A grant lists classes up to `invoke`, plus `clipboard`, `handoff` and `observe-screen` only when the user ticks them. `destructive` and `credential` cannot appear in a grant. `observe-screen` is not pre-ticked.

**Approvals** (for `destructive`, `handoff`, `clipboard` and first `invoke`): single-use, expire in 60 seconds, resolve as deny when unanswered, never queued, never remembered, never answered by the model, and **never available in Bypass or any permission mode**: the chat permission modes (Ask, Accept Edits, Bypass) do not apply to this namespace. Integrity requirements are in 4.9.

### 4.4 The classifier

Misclassifying as safe is the failure that matters, so the classifier is **fail-closed**:

1. **Inputs.** The element's accessibility role, label, description and help text, its enclosing window and sheet, the app profile if one exists, and, for keyboard actions, the **currently focused element**. The model never supplies the class; the driver computes it from the live tree at the moment of the action.
2. **Labels in any language.** Verb tables exist for English and Japanese at minimum and are data, not code. A label in a language with no table is treated as unknown, which is `destructive`. Ambiguous labels (OK, Continue, Yes, Apply, Done, Next, Confirm) are **not** inferred from their text: their class is taken from the surrounding context (the sheet or dialog message, the window's role); if the context contains any destructive verb or cannot be read, the action is `destructive`.
3. **`desktop.key` and `desktop.type` are classified by the focused element, not by the chord.** Return, Enter or Space can press a default Send or Delete button; a key that would activate a default or focused button takes that button's class. Typing into a focused control that auto-submits (search-as-you-go, a single-line field with a default button, chat-style inputs) is classed by what the submit does; if that cannot be shown, `destructive`.
4. **`desktop.set_value` is classified by the target's role**: a slider or checkbox is benign; a text field that feeds a form or a default button, a combo box that triggers an action, or any role the driver cannot map is `destructive`.
5. **Scripting, macro, shortcut or plugin menu items** (Scripts menu, Shortcuts, Services, Macros, add-in menus) are `destructive` by default; detection is by menu path and by owner outside the app's own bundle.
6. **Unclassified app default.** For an app with no profile, anything beyond `observe-tree` and `navigate` needs approval.
7. Empty-label, icon-only, custom-drawn (no accessibility node) or unknown-role elements are `destructive` until proven otherwise.
8. **State-change rules.** A form submit, a window-modal confirmation, or a sheet that appears after an action raises the next action to `destructive` regardless of its label. A **focus change** to another window, a **drag-and-drop** (within an app is `invoke`; to anywhere outside the granted windows is `handoff`), and any **open/save panel** are classified by rule, not by label:
   - Open and save panels are often hosted by a system service, so the panel's process is **not** the granted app's bundle id and identity matching fails. First-release position: such a panel is not driveable; the driver pauses (amber) and the agent calls `ask_user` so the user chooses the file. The agent cannot pick a path through a system panel.
9. **No coordinate clicks** exist in the first release. Targets are accessibility elements from a snapshot, referenced by opaque id; the action is performed on the AX element (`AXPress`, value set) and not by posting a pointer event where possible (4.6, 5.6).

### 4.5 Credentials and secure fields

- A field whose role is secure (macOS `AXSecureTextField`, Windows UIA `IsPassword`, toolkit equivalent) is **never read and never written**; its value is reported as redacted and a write fails with `credential_field`. On Windows `IsPassword` is best effort and not a guarantee (custom-drawn password fields exist); the classifier's unknown-role rule is the backstop.
- **System security UIs** (macOS SecurityAgent and Touch ID sheets, Windows UAC and Windows Hello, polkit and keyring prompts on Linux) are detected by owner process or window class and **auto-pause the grant amber**; no snapshot, screenshot or input happens until they are gone. The detection list is data and covered by a spike.
- If secure event input is enabled, synthetic typing stops and the grant pauses (4.1).
- When login is needed the agent calls `desktop.ask_user({ message })`: the shell shows a banner, pauses the grant clock, and resumes on Continue. **The first snapshot after the pause redacts every field whose value changed during the pause**, so the agent never learns what the user typed. The agent receives nothing typed in between.
- Password managers are denied (4.2). The clipboard class exists because auto-typed credentials often ride on it; **pasteboard concealed types** (e.g. the macOS concealed marker) make clipboard reads fail.
- Screenshots of a window containing a secure field blank that element before they leave the shell when the OS offers the element's frame (confirmed per OS in a spike); otherwise the screenshot call fails for that window.
- The browser dedicated profile has autofill, password manager and sync off (section 7).

### 4.6 Visibility and the kill switch (fail-safe design)

**"Agent is driving" indicator.** Drawn by the Rust shell, **outside the webview and the sidecar**:

- a coloured border around each granted window and a small always-on-top badge naming the app, the time left and a **Stop badge/button**;
- a menu-bar or tray state visibly different while any grant is live;
- amber while paused (focus rule, `ask_user`, secure input, system security UI), red when the kill switch tripped;
- an OS notification when a grant starts and ends (screen-reader users). On Windows the OS capture border is not an indicator and is not counted as one.

**Kill switch triggers.** The global hotkey is **one** trigger and is not relied on alone:

| Trigger | Notes |
|---|---|
| Global hotkey (modifier required, user-changeable) | Registered by the **shell** with the OS. **If registration fails, grant creation is blocked** (the user is told why). The registration is **re-verified while any grant is live**; failure pauses the grant. Secure event input can swallow hotkeys, which is why that state pauses the grant (4.1). |
| Stop badge button and tray item | **Mandatory, non-keyboard**: a mouse or touch route always exists. |
| Closing the lid, screen lock, fast-user-switch, sleep | Revoke all grants. |
| Physical input while driving | Real user input (distinguished from the driver's by event source tag and HID provenance) **pauses** the agent so the user can take over. **This is a convenience, not a security control**: an event-source tag is not authentication, and malware can forge or suppress it. Resuming needs a click. |
| Shell exit or crash | The driver and the shim die with the shell (process-group kill, owned by the shell). Grants are in memory and vanish. |
| Phone or relay: **stop only**, see 5.4 | Optional. |

**Kill procedure.** The process-group kill and the whole gate live in the **shell**, not in Node, so the kill works with Node frozen (tested with the Node core SIGSTOPped, target 250 ms). On trigger, in order: stop accepting tool calls (`killed`), **cancel the in-flight turn** in the core (not only the tool call), cancel the in-flight driver call, **release any held key or mouse button**, revoke every grant, keep the indicator until acknowledged, write the audit record, and set a lock-out: no new grant can be created until the user clicks "Re-enable desktop control" in the shell (a physical click on a shell-drawn control). Target: **no injected event after 250 ms** from the trigger, measured (section 9).

**Never an unpaired down event.** The driver never posts a key-down or button-down without its up in the same atomic operation:

- clicks and keystrokes are atomic (down and up emitted together);
- drags are bounded (maximum duration and distance) and implemented as one operation with a guaranteed release;
- a **watchdog** in the shell tracks every modifier and button the driver holds and **releases them if the driver dies** (kill -9 test), is not heard from, or the kill trigger fires.

### 4.7 Audit log

- **Location and owner:** a file under the app's data directory written by the **shell** (not the Node core), JSON Lines, append-only, mode 0600. Content never goes through the model.
- **Hash chain, honestly described.** Each line carries `prev` and `h` (SHA-256 of the canonical line without `h`). The chain **detects accidental corruption and naive tampering** (an edit, reorder, or truncation by someone who does not also update the anchor). It does **not** stop an attacker with the user's privileges, who can rewrite the file and the anchor. The text calls it a hash-chained log, not "tamper-evident" against a capable adversary.
- **Anchor.** The latest hash and line count are written to the OS keychain (the store `desktop/src-tauri/src/secrets.rs` wraps) **every N lines or T seconds, whichever comes first** (default 25 lines or 30 seconds), and at grant end and kill. **Crash-gap rule:** on next start, lines after the last anchor are accepted only if their chain is internally valid and are marked "unanchored tail"; a missing tail beyond the anchor is a detected truncation.
- **Mirror:** a content-free summary event goes to the server `audit_log` (`desktop.grant`, `desktop.action_denied`, `desktop.killed`). The shell file is authoritative.
- **Retention:** 90 days by default, exportable. **Deletion only via a local-presence approval (4.9), never while any grant is live, and it leaves a surviving tombstone** (what range was removed, when, by which approval) kept in the chain and the anchor.
- **No secrets:** typed text is logged as a length and a SHA-256 prefix, never the text, and never at all for a field the driver could not prove non-secure. **Element names are hashed, not stored in clear** (the example line below shows a hash). Screenshots and trees are not stored.

Example line:

```json
{"v":1,"seq":1042,"at":"2026-10-31T10:42:07.318Z","turnId":"t_9f2","grantId":"g_a1","app":{"id":"com.apple.TextEdit","signer":"APPLE"},
 "tool":"desktop.press","class":"invoke","target":{"role":"AXButton","nameHash":"5e2a...","windowTitleHash":"3c9f..."},
 "decision":"allowed","approval":null,"snapshot":"d41d8c...","result":"ok","durationMs":38,
 "prev":"9b1c...","h":"77ae..."}
```

Denied calls, approvals (granted, denied, timed out), grants, expiries, pauses, `ask_user`, grant-request spam lockouts and every kill are logged. A call the grant did not cover is logged as `denied` with the reason, because those are the injection attempts a reviewer wants to see.

### 4.8 Indirect injection hygiene in the tree

- The snapshot **drops hidden, off-screen, zero-size and fully transparent nodes** (the usual place to hide instruction text).
- **Window titles, notification text, tooltips and any text the app does not own are attacker text**: they are fenced as untrusted data like every tool result and never used to decide a class or grant.
- **Taint is by origin and document, also within one app** (5.3): a mail body and the user's own note in the same app are different origins.

### 4.9 Approval and grant dialog integrity

The dialog is the last line of defence, so it must not be spoofable by something the agent can draw or click:

- **Trust anchor the agent cannot draw.** Every shell dialog shows a shell-owned element at a fixed screen position that content windows cannot reproduce: a per-install secret phrase (chosen at setup, shown in Settings, never sent to the core) or an OS-native alert above screen-saver window level. A dialog without the anchor must be distrusted; the setup flow teaches this.
- **Refuse to render** when the dialog would be occluded or not key (another window above it, covered by an overlay); in that case the request is denied and logged.
- **Minimum display time** before Allow is enabled (default 1.5 s) and **default focus is Deny**.
- **HID-source and frontmost checks:** the click must come from a physical HID source, and the dialog must be frontmost at click time; otherwise it is void.
- **Local-presence proof** (Touch ID or system password) is required for `destructive` and `handoff` approvals and for audit deletion. The proof is requested by the shell through the OS; it is a spike item (keychain and biometric anchor mechanics).
- **Approval fatigue controls:** batching rules (benign `invoke` after the first is not re-asked; a batch of identical destructive actions is still one approval each), a **visible counter** of approvals this grant, and an automatic grant suspension after 5 approvals in 2 minutes (the user is asked whether to continue).
- **Hostile overlay test:** a fixture app that draws a fake dialog over, under and around the real one must not be able to produce an Allow (section 9).

### 4.10 Budgets and rate limits

- **Global actions per second** with a minimum interval between driving calls (default 250 ms), plus per-grant `maxActions`.
- **Per-grant `maxTurns`, `maxTokens` and `maxCostUsd`**; reaching a cap pauses the grant and asks.
- **Repeated-identical-action detector:** the same action on the same target N times in M seconds pauses amber.
- **Expiry uses a monotonic clock** (4.1).
- `request_grant` spam limits in 4.1.

## 5. Architecture

### 5.1 Topology: one trusted process, one zero-authority shim

```text
model -> Node core / Agent SDK turn --stdio MCP--> desktop-mcp-shim   (ZERO authority, signed, thin)
                                                        | authenticated per-turn-token Unix socket / named pipe
                                                        v
Rust shell (the ONE trusted process): grants, policy gate, approvals, indicator, hotkey, audit, input injection
                                                        |
                                            OS accessibility, capture, input
```

- **Exactly one trusted process owns every authority**: grants, the policy gate, approvals, the indicator, the hotkey, the audit writer and input injection. This is the Rust shell. There is no second gate and no policy in the driver, the shim or Node. (The first draft placed the gate in a "driver below MCP" while also saying it was inside the shell; this revision resolves that contradiction.)
- The **MCP stdio server** that the core or Agent SDK spawns is a **thin shim with zero authority**. It only forwards tool calls to the shell over an **authenticated Unix domain socket (macOS, Linux) or named pipe (Windows)**, authenticated with a **per-turn token** the shell mints, bound to OS user and peer credentials; the socket has mode 0600 in a shell-owned directory and no TCP listener exists. The shim holds no grants, caches no decisions and can be replaced or killed without changing what is allowed.
- **First-party mount.** The exception to the mount's "every MCP call asks first" rule is **a distinct built-in mount keyed on the signed shim identity plus the per-turn token**, not a flag on the generic MCP mount. The generic mount keeps its always-ask rule for every other server; a user-installed server cannot become first-party by setting a field. The server names **`desktop` and `browser` are reserved** and the generic mount refuses to register them.
- **Strict schemas.** Every tool schema sets `additionalProperties: false` and the Rust deserialiser rejects unknown fields too (both ends). **Only the 14 named operations in 5.6 are reachable**; the shell rejects any other method name.
- **Process-group kill and gate live in the shell.** Killing must work with Node SIGSTOPped (4.6).
- A **driving turn** is a turn that has the `desktop.*` tools attached. It runs **without** the shell tool, write tools, web fetch or any connector that posts (5.2).

### 5.2 Lethal combination rule

Private data in view, untrusted content, and an outbound channel together are what make exfiltration work. While a grant is live, the turn excludes the outbound channels by default: no `run-bash`, no web fetch or search, no connectors that post, no file writes outside the project. The user can add one back for the turn with a normal approval, and the log notes it. This is the single strongest control against T1 and T3.

### 5.3 Cross-app and in-app taint

Data that came from app A (tree text, screenshot, clipboard) is marked **tainted by A**, and within one app by **origin or document** (4.8). A later write into app B or another origin, a clipboard write, a handoff or any outbound tool in the same turn needs a per-action approval that names both. The mark lives in the shell's turn state, not in the model's text.

### 5.4 The phone and relay tier ceiling

Per the relay design (D1, D2): the PWA holds read subkeys and queues low-risk classes only; a remote-origin turn runs under a **fixed read-only ceiling that never inherits the desktop's mode**. Phase 7 adds, and the relay R0 spec must carry, these rules:

- `desktop.*` and `browser.*` tools are **not in the remote-safe tool set**. No relay request class can start a driving turn, request, extend, approve or answer a grant, or answer a Phase 7 approval. Approvals are live-only on the desktop.
- **A turn whose input includes any remote-queued text can never attach `desktop.*` tools**, even when started on the desktop; the shell checks provenance of the turn input, not only the request class.
- **Loop, Auto Tasks and scheduled jobs cannot mount the namespace.** A Loop spawned from a driving turn inherits no grant and no tools from it.
- Native iOS gets **no** drive or approve capability.
- **Stop is the one allowed remote action** ("revoke all desktop grants and set the lock-out"). Properties: it is **uniform-response** (same reply whether or not a grant existed), **idempotent**, **rate-limited**, available to the native iOS tier only (never the PWA). Because stop can only reduce capability, the lock-out it sets **persists until a local click** on the desktop; a remote party can never clear it.
- Grants are bound to the OS user and the core `userId` (4.1); a grant request from a remote-origin turn is refused by the shell regardless of what the core says.

### 5.5 Screenshot, tree and content egress

- **Tree-only by default with cloud providers.** Screenshots (`observe-screen`) to a **cloud** model provider are **disabled until a DLP pass exists**; a **local or self-hosted provider** may receive screenshots. The grant dialog states which provider will see the window.
- The first time per provider the shell asks once what is sent; consent is per provider connection, in Settings, revocable and audited.
- Screenshots are window-scoped, downscaled and held in memory only.
- **Images and trees never pass through the relay, logging, or the SSE replay buffer.** The chat SSE replay buffer must be checked: `desktop/src-tauri/src/sse_replay.rs` is the Phase 0 bench replay server (it replays recorded v2 events), so the check is on the real core event path and the buffer that backs reconnect replay. A grep-based spike (13) plus a test assert that no tool result from the namespace is written to any log, replay buffer, relay envelope or persisted session store; results are either withheld from persistence or stored as a content-free placeholder.

### 5.6 MCP tool shape (14 operations)

The shim exposes **at most 14 tools, under 12 000 characters of schema in total**, so a driving turn leaves budget (`MCP_LIMITS`: 48 per server, 96 per turn, 16 000 per tool schema, 60 000 tool JSON per turn, descriptions 1 000, one result 30 000, 60 s per call).

| Tool | Class | Notes |
|---|---|---|
| `desktop.list_granted` | none | Granted apps, classes, time left. |
| `desktop.request_grant` | none (asks) | Opens the native dialog; rate-limited (4.1). |
| `desktop.snapshot` | `observe-tree` | Tree of the focused granted window; hidden nodes dropped; depth and node caps; opaque ids; secure values redacted; under the 30 000 cap. |
| `desktop.screenshot` | `observe-screen` | Window-only; tree-only rule for cloud providers (5.5). |
| `desktop.focus` | `navigate` | Within the granted app. |
| `desktop.scroll` | `navigate` | |
| `desktop.press` | `invoke` or `destructive` (computed) | Element id from the latest snapshot; performed as `AXPress`. |
| `desktop.type` | `input-benign` or by focused element | Into an element id; fails on secure fields. |
| `desktop.key` | by focused element (4.4) | Atomic down+up. |
| `desktop.set_value` | by target role (4.4) | Through the accessibility API. |
| `desktop.clipboard` | `clipboard` | Per-action approval. |
| `desktop.open` | `handoff` | Per-action approval with local-presence proof. |
| `desktop.ask_user` | none | Pauses for the user (4.5). |
| `desktop.release` | none | Ends the grant early. |

**TOCTOU control.** Actions are performed on the **AX element reference** (`AXPress`, set value), not on coordinates. **Every action re-resolves the element and re-checks frontmost window and modal state** immediately before acting. A **snapshot id is tied to the grant and the turn**; a snapshot from another grant, turn, or any earlier snapshot of that window fails with `stale_target`. Every tool result is wrapped as untrusted data. The `browser.*` namespace (section 7) has the same shape and the same gate.

## 6. Per-OS capability reality

Rows marked **P** are backed by the Phase 0 probe in this repo; **K** means general platform knowledge not checked here, and each K row is the subject of a spike (section 10). The first draft contained probable errors, corrected below.

### macOS (first, ship first)

| Capability | Reality | Basis |
|---|---|---|
| Read UI | The Accessibility API requires the user to enable the app in Privacy and Security, Accessibility. `AXIsProcessTrusted()` is the check; untrusted yields `permission_denied`. | P (`ax_probe.rs`, report) |
| Which process holds the permission | TCC attributes by the **responsible process**, which depends on how the process was launched. A child may be attributed to the parent app, to itself, or to a launcher, and this can differ between a dev run and a release. Signing identity must be stable. Whether the shim, the shell or a helper must hold the permission is decided by the attribution-matrix spike, not assumed. | K (spike 1) |
| Screenshots | Screen Recording is a separate permission. Recent macOS versions (Sequoia, Tahoe) **re-prompt periodically** for continuing capture, and the OS **picker may let the user choose a different window or the whole display** than the grant named. The design must expect revocation mid-session and must verify what was actually captured before sending. Window-level capture (ScreenCaptureKit) may require accepting the OS picker UX. | K (spike 2) |
| Input injection | Synthesised events need the Accessibility permission. Secure event input blocks them. **An event-source tag distinguishes events but is not authentication**; it is a UX hint (4.6). | K (spikes 3, 4) |
| **Revocation** | Revoking Accessibility or Screen Recording for the app mid-session is an operating-system action the shell cannot veto. **Revocation = kill**: on any permission-state change the shell revokes all grants. | K |
| Scripting other apps (Apple Events) | Separate Automation permission per target app; out of scope for the first release. | K |
| Secure fields | `AXSecureTextField`; value withheld by the OS. | K |
| Distribution | Developer ID signing with the **hardened runtime** and notarisation; the hardened runtime and entitlements are distinct mechanisms, and which capture and automation capabilities need entitlements versus user permission is confirmed in a spike rather than asserted. Sandboxed builds cannot drive other apps, so the Mac App Store is out. | K |
| Prompts are user-granted only | There is no API to grant them programmatically. | K |

### Windows

| Capability | Reality | Basis |
|---|---|---|
| Read UI | UI Automation works across processes at the same or lower integrity without a prompt. **UIPI silently drops** input to higher-integrity (elevated) windows with no error. The driver therefore performs an **explicit integrity-level check** per target process and refuses elevated windows rather than relying on an error. | K (spike 9) |
| Input | `SendInput` cannot reach the secure desktop (UAC, lock screen); those must not be driven. | K |
| Capture | The Graphics Capture API shows a capture border on current Windows 11 builds. **The border is not an indicator** of the design and does not replace it (4.6). | K |
| App identity | Executable path plus Authenticode signer; MSIX apps use the package family name. | K |
| Secure fields | `IsPassword` on UIA elements, **best effort** (4.5). | K |

### Linux (best effort, last)

| Capability | Reality | Basis |
|---|---|---|
| X11 | Any client can read windows and inject events. **A per-app grant cannot be enforced**; advisory only. AT-SPI and X11 access are **session-wide**, not per app. | K |
| Wayland | Global input injection and capture go through the desktop portal with a user prompt. **Portal grants are device-wide for the session, not per app**, so a per-app guarantee cannot be made; the grant is advisory beyond the compositor's prompt. Features differ per compositor. | K (spike 10) |
| Accessibility tree | AT-SPI over D-Bus, session-wide; GTK and Qt expose it, Electron and some toolkits expose little. | K |
| Webview | WebKitGTK is already the weakest graphics target (Tauri plan risks). | P (plan) |

**Position:** macOS fully designed and built first. Windows second, observe and benign input only. Linux: experimental, advisory, disabled by default on X11.

## 7. Browser tier (separate, optional, off by default, deferred)

The browser tier is **deferred until the desktop tier has passed final review** (P7.8). It is a **separate optional driver extension**, not part of the desktop shim, and it is **off by default**. When built:

- **Dedicated browser profile only**: no sync, no other extensions, autofill and password manager off, **cookies cleared at grant end**.
- The extension talks to the shell; the **gate stays in the shell**. The shell mints **origin-bound, per-call tokens** signed by the shell; the extension cannot widen origin or class.
- **Excluded explicitly:** `evaluate`, `executeScript`, the Chrome DevTools Protocol and the `debugger` API, and cookie access. These cannot be called even if requested.
- **Per-origin grants** via the browser's own optional-host-permission prompt; never `<all_urls>`.
- **Navigation off the granted origin fails closed**: redirects, `window.open`, and frames to other origins stop the action. `file://`, `chrome://`, `about:`, extension pages, and `blob:` and `data:` URLs are **never grantable**.
- **Downloads are quarantined and never opened.**
- Page text is untrusted data; password and payment fields are never read or written; forms, purchases and downloads are destructive.

## 8. Interaction with existing controls

- **Permission modes** (Ask, Accept Edits, Bypass) do not apply to this namespace; Bypass does not skip approvals.
- **Workspace Trust** still decides which MCP stdio servers start; the shim is not one of those servers (distinct built-in mount, 5.1).
- **Extensions catalog** switches can hide the namespace per user and per project; a restricted mode removes it.
- **Loop, Auto Tasks, jobs:** the job runner refuses any job whose turn would attach `desktop.*` (a static check plus the shell's origin check), and a Loop started from a driving turn inherits nothing (5.4).
- **Outbound pinning:** the shell and shim make no network calls; the audit mirror uses the existing server route.

## 9. Test plan

All tests run **without a paid model call** except the one named run below: a scripted fake model emits attacker-chosen tool calls, because the gate, not the model, is under test.

| Area | Tests |
|---|---|
| Policy gate (property tests and an **exhaustive small-state model**) | No tool call succeeds without a live grant for that app and class; expiry, idle expiry, action count, focus loss, secure input and turn change each revoke. The gate state machine (no-grant, requested, granted, paused amber, killed and locked, expired) is modelled with a small state space and **checked exhaustively** over all event sequences up to a bound. `destructive` and `credential` never appear in a grant. |
| Hostile fixture app | Injection text in labels, titles, hidden and zero-size nodes, a fake notification; a "Delete" button; a password field; a second window of another app; a drag-out item. Scripted attacks blocked and logged. **The fixture is also run once with the real Claude model in P7.2** (the only paid call, budget-capped, user-approved) to confirm the fake model's attacks are representative. |
| Approval integrity | Approval cannot be answered by synthetic input; timeout denies; a changed target voids it; replay fails; **overlay spoof** (a fake dialog over, under, around); occlusion refusal; minimum display time; **Touch ID gating** proves a destructive approval cannot complete without it. |
| Kill switch | Hotkey, button and lid each stop within 250 ms in a loaded run; **hotkey intercepted by another app or by secure input**; **Node SIGSTOPped, kill still within 250 ms**; **driver crash (kill -9) with held input** leaves no key or button down; no event after the trigger; lock-out persists until a local click; kill also cancels the in-flight turn; shell or sidecar crash leaves no driver or shim process. |
| Classifier | **Auto-submit** catalogue (Return on default Send or Delete); **`set_value` on a destructive control**; **script/macro/shortcut menu item**; Japanese and non-English labels; OK/Continue/Yes/Apply ambiguity; **sheets and open/save panels** (system-hosted panel not driveable); drag-drop and focus-change rules; unclassified-app default. |
| Injection hygiene | **Hidden injection text** never reaches the model; **notification overlap** (a notification over the target) fails closed; window-title text cannot change a class. |
| Egress and leakage | A driving turn has no shell, fetch or poster tool; cross-app and in-app taint demands approval; **no tree, screenshot or typed content in logs, the SSE replay buffer, relay envelopes or session persistence** (grep test over real artefacts after a run). |
| Time and concurrency | **Clock changes and sleep** do not extend or resurrect a grant (monotonic); **two simultaneous turns** cannot share or both hold grants for one app; **shell restart loses grants**. |
| Request spam | `request_grant` rate limit, back-off and lockout engage; lockout needs a local click. |
| Audit | Chain verifies; edit, delete, reorder and truncation detected using the anchor; **crash between anchors** follows the crash-gap rule; deletion only with local-presence approval and never with a live grant; tombstone survives; no secret text or screenshot content; element names hashed; denied calls present. |
| Remote tier | Every relay request class against `desktop.*` and `browser.*` refused in every mode including Bypass and with a grant live; a turn with remote-queued input cannot attach the namespace; Loop and Auto Tasks cannot mount; stop is uniform, idempotent, rate-limited, native-only; remote stop's lockout is cleared only by a local click. |
| Schema and shim | Tool JSON under 12 000 characters; results under 30 000; unknown fields rejected on both ends; any non-listed method rejected; reserved names `desktop` and `browser` refused by the generic mount; a forged token or unsigned shim is refused by the shell. |
| Per-OS | macOS permission states (denied, granted, revoked mid-run = kill), signing identity stability, screen-capture re-prompt and picker behaviour; Windows integrity-level refusal; Linux advisory banner. GUI runs need a real desktop: manual `(you)` steps in the exit gates. |
| Fuzz | Tool arguments (oversized, wrong type, control characters) and malformed or adversarial accessibility trees. |

## 10. Phases and exit gates

Default off behind a flag throughout. Nothing before P7.2 touches the OS beyond spikes run by hand.

**P7.pre: research spikes (gated, before P7.1).** Throwaway experiments, results recorded in a spike report; no product code. Each spike has a written question, a pass or kill outcome and a design consequence. A spike that kills a claim sends the design back to review.

| # | Spike | Question answered |
|---|---|---|
| 1 | TCC attribution matrix | Which process (shell, shim, helper) must hold Accessibility and Screen Recording under dev, release, launched-from-Finder and launched-from-terminal runs; how responsible-process attribution changes it. |
| 2 | Screen-capture mode and re-prompt cadence | Window versus display capture, what the OS picker allows, how often Sequoia/Tahoe re-prompt, how to verify what was captured. |
| 3 | Hotkey under secure input and SIGSTOP | Does the hotkey fire under secure event input and with Node frozen; what is the kill latency. |
| 4 | Held-input leak on kill -9 | Does killing the driver mid-click or mid-drag leave a key or button down; does the watchdog recover it. |
| 5 | Approval spoof, overlap and Touch ID gating | Can a hostile window imitate, cover or click-through the dialog; can the shell require Touch ID or password for approval. |
| 6 | Return/auto-submit catalogue | Which common controls submit on Return or typing; how to detect default buttons from the tree. |
| 7 | AX hidden content | What hidden, off-screen, zero-size or transparent nodes appear in trees of target apps. |
| 8 | Menu script items | How scripting, shortcut and plugin menu items are identified by path and owner. |
| 9 | Windows UIPI | Explicit integrity-level check behaviour; silent-drop cases. |
| 10 | Linux portals | Portal grant scope (device-wide versus per app), per-compositor differences. |
| 11 | Browser tier feasibility | Dedicated-profile controls, origin-bound token flow, excluded APIs, download quarantine. |
| 12 | Keychain anchor mechanics | Anchor write cadence, access control, behaviour on keychain lock, and the local-presence proof API. |
| 13 | Replay/log leakage grep | Where tool results could be persisted or replayed (core event path, SSE replay buffer, session store, relay envelope, logs). |

| Phase | Scope | Exit gate |
|---|---|---|
| **P7.0 Specify and review** | This design to a frozen spec; independent re-review of revision 2. | Review signs off; user questions in section 12 answered; no code before. |
| **P7.pre Spikes** | The 13 spikes above. | Spike report reviewed; design amended where a claim was killed; re-review if material. |
| **P7.1 Policy core with a fake driver** | Grants, classes, classifier, approvals, kill switch, audit chain and anchor, authenticated socket, shim, in the shell against a fake driver and scripted model. | Policy, approval, kill, audit, remote-tier tests pass, including the exhaustive state-model check; permission matrix covers every mode including Bypass. |
| **P7.2 macOS observe-only** | AX tree snapshot and window screenshot (local provider only for screenshots); indicator; secure-field blanking. | Hostile-fixture run passes, **including one real-Claude run**; real macOS run by the user with TCC granted and revoked; capture scope verified; egress consent works. |
| **P7.3 macOS benign input** | `navigate`, `input-benign`, `invoke`, focus rule, human-takeover pause, atomic events and watchdog. | Kill latency under 250 ms on a real Mac including Node SIGSTOP; held-input test; stale-target rejection. |
| **P7.4 Destructive and handoff approvals** | Approval dialogs, trust anchor, local-presence proof, classifier tables, clipboard and handoff, taint. | Adversarial corpus fully blocked; overlay and Touch ID gating tests; independent review of the classifier. |
| **P7.5 Windows** | UIA observe and benign input, integrity check. | Real Windows run by the user; elevated refusal proved. |
| **P7.6 Linux** | AT-SPI observe, portal-driven input, advisory banner. | Experimental; X11 off by default. |
| **P7.7 Browser tier** | Separate extension per section 7. | Only after the desktop tier passed P7.8; origin-scoping and excluded-API tests. |
| **P7.8 Final review** | External security review of shipped desktop behaviour (the Tauri plan's Phase 7 gate). | Review passed; then the flag may default on for macOS only. |

(Phase numbers P7.5 to P7.7 are reordered from the first draft so the browser tier follows the final review, per the deferral decision.)

## 11. Residual risks, stated plainly

- A compromised user account can disable the shell's protections and rewrite the audit log and its anchor; the chain detects accidental corruption and naive tampering, not a capable adversary.
- The classifier is heuristic. Fail-closed lowers harm but blocks legitimate actions on custom-drawn controls; `ask_user` is the escape.
- Physical-input pause is a convenience: input provenance is forgeable by same-user malware.
- Approval fatigue is reduced, not removed.
- Screenshots to a third-party provider are barred in the first release for cloud providers; trees still go to the provider.
- Prompt injection is not solved; this design removes the capabilities an injection would need (other apps, communicating apps, shell, network, credentials, destructive clicks without a human with local-presence proof) rather than trying to detect the text.
- On Linux X11 and Wayland portals per-app grants are advisory.
- macOS capture re-prompts and the OS picker can change what is captured; this is detected and verified, not prevented.

## 12. Decisions: provisional defaults and open user questions

### 12.1 What the user has actually said

The user said earlier "i want a secure system" and delegated the relay choices to the secure option. They have **not** individually answered the Phase 7 questions. The secure recommendations below are therefore adopted as **provisional defaults** so work can proceed; each is to be revisited with the user.

| # | Provisional default | Status |
|---|---|---|
| D1 | One trusted Rust process owns all authority; MCP stdio server is a zero-authority shim over an authenticated per-turn socket (5.1). | provisional, revisit with the user |
| D2 | Local-presence proof (Touch ID or system password) for destructive and handoff approvals. | provisional, revisit with the user |
| D3 | No communicating, scripting-capable or browser apps in the first release (4.2). | provisional, revisit with the user |
| D4 | Tree-only to cloud providers; screenshots only with a local provider until a DLP pass exists (5.5). | provisional, revisit with the user |
| D5 | Audit deletion only by local-presence approval, never with a live grant, with a surviving tombstone (4.7). | provisional, revisit with the user |
| D6 | Browser tier is a separate, optional, off-by-default extension, deferred until the desktop tier passes final review (7). | provisional, revisit with the user |
| D7 | Stop-only from the native iOS app accepted, never from the PWA (5.4). | provisional, revisit with the user |
| D8 | First-party exception is a distinct built-in mount keyed on the signed shim identity and per-turn token (5.1). | provisional, revisit with the user |
| D9 | Global budgets: action interval, per-grant turns, tokens, cost, repeated-action detector (4.10). | provisional, revisit with the user |
| D10 | Accept the OS screen-capture picker UX if the spike shows it is required (6). | provisional, revisit with the user |

### 12.2 Questions that truly need the user

| # | Question | Recommendation |
|---|---|---|
| Q1 | macOS only for the first release, or all three OSes? | macOS only; Windows after; Linux experimental. |
| Q3 | Terminals and shell apps: denied (recommended) or grantable with `destructive` for every key? Note this revision also denies IDEs, mail, chat and browsers by desktop path (D3), which narrows the first use cases to notes, editors and viewers; is that acceptable? | Deny in the first release. |
| Q5 | Grant lifetimes: default 15 minutes, maximum 4 hours, idle 5 minutes (monotonic)? | Yes; shorter is safer and a re-grant is one click. |
| Q8 | Offer the agent-visible `ask_user` sign-in handoff in the first release (with post-pause field redaction)? | Yes; without it the agent fails at the first login wall. |
| Q9 | Review scope: one independent review for the relay R0 spec and this design together for the shared clause (remote ceiling and stop-only), separately for the driver? | Together for the shared clause, separately for the driver; this revision also needs the independent re-review. |

Resolved by provisional defaults above and no longer open questions: first-party exception (old Q2, now D8), stop-only (Q4, D7), screenshots to cloud (Q6, D4), browser profile (Q7, D6 and section 7), audit deletion (Q10, D5).

## 13. Finding to design-change traceability

| Review finding | Design change |
|---|---|
| S1: topology contradiction between "gate in driver" and "in shell" | One trusted Rust process; MCP server is a zero-authority shim over an authenticated per-turn socket; kill and gate in the shell (5.1, 4.6). |
| First-party exception was a flag on the generic mount | Distinct built-in mount keyed on signed shim identity and per-turn token; `desktop` and `browser` reserved (5.1, D8). |
| Loose schemas and reachable operations | `additionalProperties: false` in schema and Rust; only the 14 ops reachable (5.1, 5.6). |
| `request_grant` spam | Rate limit, back-off, lockout (4.1, tests). |
| Kill switch could fail open | Atomic events, bounded drags, watchdog, hotkey-failure blocks grants, re-verify, mandatory non-keyboard stop, secure-input pause, kill cancels turn, physical-input pause demoted (4.6). |
| Kill had to work with Node frozen | Process-group kill in the shell; Node SIGSTOP test at 250 ms (4.6, 9). |
| Approval could be spoofed or fatigued | Trust anchor, occlusion refusal, min display time, default Deny, HID and frontmost checks, local-presence proof, batching, counter, overlay test (4.9). |
| Indirect injection | Narrow grantable categories; taint by origin; hidden-node filtering; window titles as attacker text; observe-screen higher risk (4.2, 4.8, 5.3). |
| Screenshot and data egress | Tree-only to cloud, local provider for screenshots; nothing through relay, logs or replay buffer; sse_replay check (5.5, spike 13). |
| TOCTOU | Act on AX element, re-resolve and re-check per action, snapshot ids tied to grant and turn (4.4, 5.6). |
| Classifier gaps | Fail-closed, Japanese and non-English labels, ambiguity rules, focused-element classification, set_value by role, script menu items destructive, unclassified default, drag/sheet/panel rules, never-overridable list (4.2, 4.4). |
| Credentials | Security UIs auto-pause; post-pause redaction; autofill and sync off; concealed pasteboard fails reads (4.5, 7). |
| Browser tier scope | Separate, off by default, dedicated profile, signed per-call tokens, excluded APIs, origin and scheme rules, quarantined downloads, deferred (7). |
| Audit overclaimed tamper-evidence | Honest wording; anchor cadence and crash-gap rule; deletion by local-presence only with tombstone; names hashed (4.7). |
| Budgets and clock | Global rate, per-grant turn, token and cost caps, repeated-action detector, monotonic clock (4.10, 4.1). |
| Phone and relay tier | Uniform, idempotent, rate-limited stop; lockout persists until local click; OS user and userId binding; remote-queued text bars namespace; Loop and jobs barred and non-inheriting (5.4). |
| Per-OS errors | macOS re-prompts and picker, TCC attribution, revocation = kill, tag not authentication, signing wording; Wayland device-wide portals; X11 and AT-SPI session-wide; Windows UIPI integrity check, capture border not an indicator, IsPassword best effort (6). |
| Unverified platform claims | 13 gated research spikes before P7.1 (10). |
| Missing tests | Overlay spoof, hotkey intercept, SIGSTOP, kill -9 held input, auto-submit, set_value, script menu, sheets, hidden text, notification overlap, no-leak grep, clock and sleep, two turns, shell restart, spam, audit crash gap, real-model fixture run, exhaustive state model (9). |
| User decisions overstated | Provisional defaults D1-D10 marked "provisional, revisit with the user"; short list of true user questions (12). |
