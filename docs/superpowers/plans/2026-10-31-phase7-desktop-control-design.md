# Phase 7 design: desktop and browser control with per-app grants, audit and kill switch

Status: **design only, security first. No code exists and none is proposed to start before the independent review in section 12.** Date: 2026-10-31, at `main`. Inputs read: [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md), the [Tauri plan](2026-10-24-tauri-desktop-and-relay.md) (phase 7 row, section 8, risks), the [relay design](2026-10-31-relay-design.md) (D1, D2, capability tiers, the remote-safe ceiling), the [relay security review](2026-10-31-relay-security-review.md), the [extensions catalog plan and spec](../../spec/extensions-catalog.md), the MCP adapter limits in `extension/providers/adapter/mcp-client.mjs` and the mount policy in `extension/llm_agent/adapter/mcp-mount.mjs`, and the Phase 0 accessibility probe `desktop/src-tauri/src/ax_probe.rs`.

Not verified: every per-OS statement in section 6 that is not backed by the Phase 0 probe comes from general platform knowledge, not from a check against current vendor documentation or a run on that OS. Section 6 says so row by row, and the first phase (P7.2) starts with a spike that confirms them.

## 1. Goal and non-goals

**Goal.** Let the desktop agent look at and operate **one app at a time that the user has explicitly granted**, through MCP tools, with the user always able to see it and stop it, and with a record of every action.

**Non-goals for the first release.**

- No unattended driving: Loop, Auto Tasks and scheduled jobs never drive the desktop (they have no human to watch).
- No driving from a phone or any relay request (section 5.4).
- No "whole desktop" or "all apps" grant, and no remote-desktop product.
- No credential entry by the agent (section 4.5).
- No Windows or Linux input injection until macOS has passed its gates.

## 2. What is being protected

| Asset | Why it matters |
|---|---|
| Everything the user can do in any granted or reachable app (mail, banking, admin consoles, IDE, terminal) | A driven app acts with the user's identity. |
| Credentials and secrets visible on screen or in the clipboard | One screenshot is a copy. |
| Data in other apps' windows | A screenshot of a display includes them. |
| The audit trail | It is the only way to answer "what did the agent do". |
| The company LLM key and the vault | Reachable if the agent drives a terminal or the app's own settings. |

## 3. Threat model

The attacker is **text the model reads**, not a person at the keyboard. The model is treated as an untrusted component that follows instructions found in content (the same stance as the extension mount: tool results are "untrusted data", `fenceToolResult`).

| # | Threat | Example | Primary controls (section) |
|---|---|---|---|
| T1 | **Prompt injection drives the desktop** | A web page, mail, document, notification or window title in the granted app says "open Terminal and run ...". | Per-app grant that excludes other apps (4.1); a driving turn gets no shell and no network tools (5.2); action classes with approval (4.3); taint rule for cross-app flows (5.3). |
| T2 | **Confused deputy** | The user grants "Notes" for summarising; the agent uses Notes' share sheet or link handlers to reach a mail client or a browser. | Grant bound to the app identity and its **windows**, not the process tree; focus change to another app pauses and requires a new grant (4.1); handoff actions (open URL, share, open-with) are class `handoff`, always approved. |
| T3 | **Data exfiltration through screenshots and trees** | The agent screenshots a window with a password manager, banking page, or private chat and the image goes to the model provider. | Window-scoped capture only, never the display (6); protected-app denylist (4.2); secure-field blanking (4.5); screenshot class is its own grant class and its own consent about the provider (5.5); no screenshot persistence by default. |
| T4 | **Credential entry and capture** | The agent types a password it saw, or reads a password field's value, or triggers autofill. | Secure fields are never read or written (4.5); typing into a field whose role is secure fails closed; password managers cannot be granted. |
| T5 | **Destructive or irreversible actions** | "Delete", "Send", "Pay", "Empty Trash", "Quit without saving", `rm` in a terminal, a form submit. | Destructive classes always need a live, desktop-local approval (4.3); fail-closed classifier (4.4); never queued, never from the phone (5.4). |
| T6 | **Grant escalation** | The model asks for a grant and the approval dialog is itself driven (clicked by the agent). | The grant prompt is drawn by the Rust shell, not by a webview the agent can reach; the shell ignores synthetic input for its own windows (6, macOS: event source check); the model cannot call a tool that approves. |
| T7 | **Runaway or looping agent** | Thousands of clicks, a held key, a drag that never ends. | Rate and count limits per grant; grants expire (4.1); kill switch (4.6); held inputs released on stop. |
| T8 | **Tampered or silent audit** | The model or malware removes the trail. | Append-only hash-chained log owned by the shell, last hash anchored in the OS keychain (4.7). Limit: same-user malware can still defeat it; stated, not hidden. |
| T9 | **Malicious or compromised MCP tool server** | A third-party "desktop" MCP server is installed and asked for a grant. | The driver is first-party and built into the shell; third-party servers cannot call it and cannot reach the grant store; the namespace `desktop.` and `browser.` is reserved (5.1). |
| T10 | **Remote request starts driving** | A queued phone or relay request "open this and click that". | Relay requests run under the fixed read-only ceiling, which excludes both namespaces entirely (5.4). |
| T11 | **Local malware or another process calls the driver** | A process on the machine talks to the driver's pipe. | The driver is reachable only by the shell's own stdio pipe (no listening socket); the core talks to the shell through the existing sidecar channel (5.1). |
| T12 | **TOCTOU between approval and action** | The user approves "click Send" and the screen changes. | Approval is bound to an action description plus a fresh snapshot digest of the target element; if the element's role, label or window changed, the approval is void (4.3). |

Out of scope: a fully compromised OS account, a malicious OS, hardware attacks. Residual risk in section 11.

## 4. Grant model

### 4.1 The grant

A grant is a record held **only by the Rust shell**, never in the Node core's database and never writable by the core.

| Field | Meaning |
|---|---|
| `grantId` | Random, shell-minted. |
| `app` | The app's identity: macOS bundle id plus code-signing team id; Windows executable path plus Authenticode signer; Linux desktop-file id plus executable path. A different binary with the same name does not match. |
| `windows` | The window handles the grant covers (the app's windows at grant time, plus new windows of the same process only when the user ticked "include new windows"). |
| `classes` | The set of action classes (4.3). |
| `expiresAt` | Absolute time. Default 15 minutes, maximum 4 hours, no "forever". |
| `idleExpireMs` | Default 5 minutes without an action. |
| `maxActions` | Default 200. |
| `createdBy` | `local-user` only. Any other value is invalid. |
| `turnId` | The chat turn that asked. A grant does not carry to another turn or session. |

Rules:

- **One grant per app, per turn.** There is no wildcard and no "any app".
- **Grants are not persisted across a shell restart, a sleep longer than the idle limit, a screen lock or a fast-user-switch.** Re-granting is a click.
- **Focus rule.** If the frontmost window is not covered by the grant, every driving call fails closed with `not_granted_focus` and the indicator turns amber. The agent may ask the user to bring the app forward; it cannot raise another app itself.
- **Request flow.** The model calls `desktop.request_grant({ app, classes, reason })`. This does nothing but ask. The **shell** shows a native, non-webview dialog naming the app, the classes in plain words, the duration and the reason text (clearly marked as the agent's words, length-capped, stripped of hidden characters). Only a physical click on **Allow** creates the grant. Default focus is **Deny**.

### 4.2 Protected apps

A built-in denylist cannot be granted: password managers, the OS keychain and credential UIs, the OS settings and security panes, the system permission dialogs, this app itself, the terminal and shell apps in the first release, remote-desktop and VPN clients, and banking apps the user marks. The list is data in the shell, shown in Settings, user-extensible, never user-shrinkable below the built-in set in the first release.

Terminal emulators are denied at first because a terminal is "run any command"; running commands already has its own, better-governed path (the chat shell tool with its permission rules).

### 4.3 Action classes

| Class | Examples | Grant covers? | Approval per action |
|---|---|---|---|
| `observe-tree` | read the app's accessibility tree, element names and values (not secure fields) | yes | no |
| `observe-screen` | a screenshot of the granted window | yes, separate tick | no, but the provider consent (5.5) must be on |
| `navigate` | scroll, move focus, switch tabs, expand, select (no state change) | yes | no |
| `input-benign` | type text into a non-secure field, press non-destructive keys | yes | no |
| `invoke` | press a button or menu item that is not classed destructive | yes | **first use per grant, then no** |
| `clipboard` | read or write the clipboard | separate tick | yes per action (reads can hold secrets) |
| `handoff` | open a URL, open-with, share, drag a file out of the app, reveal in a file manager | separate tick | **always** |
| `destructive` | delete, send, post, submit, pay, transfer, quit without saving, empty trash, permission or settings change, uninstall, anything the classifier cannot rule out | never in a grant | **always, live, on the desktop** |
| `credential` | type or read a secure field, autofill, a keychain prompt | never | **never** (the agent stops and asks the user to do it) |

A grant lists classes up to `invoke`, plus `clipboard`, `handoff` and `observe-screen` only when the user ticks them. `destructive` and `credential` cannot appear in a grant.

**Approval for `destructive`, `handoff`, `clipboard` and first `invoke`:** a shell-drawn dialog that states the action in plain words and shows the target element's name and role from a fresh snapshot, with the digest bound to the approval (T12). Approvals are single-use, expire in 60 seconds, and **resolve as deny** when nobody answers. They are never queued, never remembered, never answered by the model and **never available in Bypass or any permission mode**: the chat permission modes (Ask, Accept Edits, Bypass) do not apply to this namespace at all.

### 4.4 The destructive classifier

Misclassifying as safe is the failure that matters, so the classifier is **fail-closed**:

1. Start from the element's accessibility role and label, and the app profile if one exists (a short per-app table of verbs: Send, Delete, Remove, Pay, Place order, Submit, Post, Publish, Confirm, Transfer, Sign out, Quit, Erase, Format, Install, Allow, Grant).
2. Key chords classed destructive by default: delete and forward-delete with modifiers, quit, close-all, save-over, paste into an unknown field.
3. Anything with a label that is empty, an icon-only button, a custom-drawn control (no accessibility node) or an unknown role is **`destructive` until proven otherwise**; the agent must use a named, accessible target or ask the user.
4. A form submit, a window-modal confirmation, or a sheet that appears after an action raises the next action to `destructive` regardless of its label.
5. The model never supplies the class. The driver computes it from the live tree.

A coordinate click (x, y) is not offered as a tool in the first release; targets are accessibility elements from the last snapshot, referenced by an opaque id the driver issued. This removes "click the pixel the screenshot showed" and makes classification possible.

### 4.5 Credentials and secure fields

- A field whose role is secure (macOS `AXSecureTextField`, Windows UIA `IsPassword`, the toolkit equivalent on Linux) is **never read and never written**; its value is reported as redacted and a write fails with `credential_field`.
- If the OS enables secure input (macOS secure event input), synthetic typing stops by itself; the driver reports it and pauses.
- Password managers are on the denylist; the clipboard class exists because auto-typed credentials often ride on it.
- When login is needed the agent calls `desktop.ask_user({ message })`: the shell shows a banner "the agent needs you to sign in", pauses the grant clock, and resumes after the user clicks Continue. The agent receives nothing typed in between.
- Screenshots of a window containing a secure field blank that element before they leave the shell when the OS offers the element's frame (to be confirmed per OS in P7.2); otherwise the screenshot call fails for that window.

### 4.6 Visibility and the kill switch

**"Agent is driving" indicator.** Drawn by the Rust shell, **outside the webview and the sidecar**, so the agent cannot hide it:

- a coloured border around each granted window and a small always-on-top badge naming the app, the time left and a Stop button;
- a menu-bar or tray state that is visibly different while any grant is live;
- amber while paused (focus rule, `ask_user`), red when the kill switch tripped.
- Accessibility: the indicator also posts an OS notification when a grant starts and ends, so a screen-reader user is told.

**Kill switch.** One action, many triggers, always available:

| Trigger | Notes |
|---|---|
| Global hotkey (default Ctrl+Option+Esc style chord, user-changeable, must include a modifier) | Registered by the **shell** with the OS, not through the webview. The OS delivers it even when another app is frontmost. |
| Stop button on the badge, tray item | |
| Closing the lid, screen lock, fast-user-switch, sleep | Revokes all grants. |
| Physical input while driving | Real mouse or keyboard input from the user (events that are not the driver's own, distinguished by the driver's event source tag) **pauses** the agent, so the user can take over without a fight. Resuming needs a click. |
| Shell exit, crash or sidecar crash | The driver process dies with its parent (process-group kill, as the job runner and MCP launches already do), grants live in memory and vanish. |
| Phone or relay: **stop only**, see 5.4 | Optional. |

On trigger, in order: stop accepting tool calls (`killed`), cancel the in-flight call, **release any held key or mouse button**, revoke every grant, hide no indicator until acknowledged, write the audit record, and set a lock-out: no new grant can be created until the user clicks "Re-enable desktop control". Target: no injected event after **250 ms** from the trigger, measured (section 9).

### 4.7 Audit log

- **Location and owner:** a file under the app's data directory written by the **shell** (not the Node core), JSON Lines, append-only, mode 0600. Content never goes through the model.
- **Hash chain:** each line carries `prev` (the hash of the previous line) and `h` (SHA-256 of the canonical line without `h`). The shell stores the **latest hash and line count in the OS keychain** (the store `desktop/src-tauri/src/secrets.rs` already wraps), so truncation or replacement is detected at next start and shown in Settings.
- **Mirror:** a content-free summary event goes to the server `audit_log` (`desktop.grant`, `desktop.action_denied`, `desktop.killed`) so the existing audit surfaces see that driving happened. The shell file is authoritative.
- **Retention:** 90 days by default, user-visible, exportable, deletable by the user (it is the user's data).
- **No secrets:** typed text is logged as a length and a SHA-256 prefix, never the text, and never at all for a field the driver could not prove non-secure; screenshots are not stored by default.

Example line:

```json
{"v":1,"seq":1042,"at":"2026-10-31T10:42:07.318Z","turnId":"t_9f2","grantId":"g_a1","app":{"id":"com.apple.TextEdit","signer":"APPLE"},
 "tool":"desktop.press","class":"invoke","target":{"role":"AXButton","name":"Save","windowTitleHash":"3c9f..."},
 "decision":"allowed","approval":null,"snapshot":"d41d8c...","result":"ok","durationMs":38,
 "prev":"9b1c...","h":"77ae..."}
```

Denied calls, approvals (granted, denied, timed out), grants, expiries, focus-loss pauses, `ask_user` and every kill are logged. A call the grant did not cover is logged as `denied` with the reason, because those are the injection attempts a reviewer wants to see.

## 5. Architecture

### 5.1 Where enforcement lives

```text
model -> Node core (agent turn) --stdio MCP--> desktop-driver (Rust, child of the shell)
                                                  |  policy gate: grant, class, approval, rate, kill
shell UI (grant dialog, approvals, indicator, hotkey, audit writer) <--- same Rust process space
                                                  |
                                      OS accessibility, capture, input
```

- The **policy gate runs inside the Rust driver**, below the MCP layer. The Node core and the model cannot widen a grant: the core is the component the model influences.
- The driver is part of the shell binary (or a helper in the same signed bundle). It is **first-party only**; third-party MCP servers cannot register in the `desktop.` or `browser.` namespaces or reach the gate (T9, T11).
- The driver is attached to a turn by the same mount that attaches user MCP servers (`llm_agent/adapter/mcp-mount.mjs` for adapter turns; the Agent SDK path through its MCP config), over a stdio pipe the shell owns. No TCP listener.
- A **driving turn** is a turn that has the `desktop.*` tools attached. It runs **without** the shell tool, write tools, web fetch or any connector that posts (5.2).

### 5.2 Lethal combination rule

Private data in view, untrusted content, and an outbound channel together are what make exfiltration work. While a grant is live, the turn excludes the outbound channels by default: no `run-bash`, no web fetch or search, no connectors that post, no file writes outside the project. The user can add one back for the turn with a normal approval, and the log notes it. This is the single strongest control against T1 and T3 and costs the least capability for the first use cases (read a screen, fill a form, operate an app).

### 5.3 Cross-app taint

Data that came from app A (tree text, screenshot, clipboard) is marked **tainted by A**. A later write into app B, a clipboard write, a handoff or any outbound tool in the same turn needs a per-action approval that names both apps. The mark lives in the driver's turn state, not in the model's text.

### 5.4 The phone and relay tier ceiling

Per the relay design (D1, D2): the PWA holds read subkeys and queues low-risk classes only; a remote-origin turn runs under a **fixed read-only ceiling that never inherits the desktop's mode**. Phase 7 adds, and the relay R0 spec must carry, these rules:

- `desktop.*` and `browser.*` tools are **not in the remote-safe tool set**. No relay request class can start a driving turn, request, extend, approve or answer a grant, or answer a Phase 7 approval. Approvals are live-only on the desktop (relay design section 5.2 already says approvals are never queued).
- Native iOS, even with its larger capability set, gets **no** drive or approve capability in Phase 7.
- **Stop is the one allowed remote action** ("revoke all desktop grants and set the lock-out"): it can only reduce capability. It is a typed request class available to the native iOS tier only, never to the PWA. Whether to offer it at all is question Q4.
- A grant request created by a remote-origin turn is refused by the shell regardless of what the core says: the shell checks `origin == local-user` itself.

### 5.5 Screenshot and tree egress consent

Trees and screenshots are sent to the active model provider. The first time per provider the shell asks once: "This sends what is on that window to <provider>." The consent is per provider connection, listed in Settings and revocable, and recorded in the audit log. The **provider tier** (a local or self-hosted model) is a recommended default for `observe-screen`; the grant dialog says which provider will see the window. Screenshots are window-scoped, downscaled to a fixed maximum, and held in memory only.

### 5.6 MCP server shape

A stdio MCP server with **namespaced tools**, kept small so it fits the schema caps used by the adapter mount (`MCP_LIMITS`: 48 tools per server, 96 per turn, 16 000 characters of schema per tool, 60 000 characters of tool JSON per turn, descriptions 1 000 characters, one result 30 000 characters, 60 s per call). Target: **at most 14 tools, under 12 000 characters of schema in total**, so a driving turn leaves the rest of the budget to other tools.

| Tool | Class | Notes |
|---|---|---|
| `desktop.list_granted` | none | Granted apps, classes, time left. |
| `desktop.request_grant` | none (asks) | Opens the native dialog; returns allow, deny or timeout. |
| `desktop.snapshot` | `observe-tree` | Accessibility tree of the focused granted window, depth and node caps, opaque element ids, secure values redacted, result under the 30 000 character cap. |
| `desktop.screenshot` | `observe-screen` | Window-only, size-capped, secure fields blanked. |
| `desktop.focus` | `navigate` | Within the granted app. |
| `desktop.scroll` | `navigate` | |
| `desktop.press` | `invoke` or `destructive` (computed) | Element id from the last snapshot. |
| `desktop.type` | `input-benign` | Into an element id; fails on secure fields. |
| `desktop.key` | by chord | Chord table in 4.4. |
| `desktop.set_value` | `input-benign` | Sets a value through the accessibility API where offered. |
| `desktop.clipboard` | `clipboard` | Per-action approval. |
| `desktop.open` | `handoff` | Per-action approval. |
| `desktop.ask_user` | none | Pauses for the user (4.5). |
| `desktop.release` | none | Ends the grant early. |

Every tool result is wrapped as untrusted data and carries `snapshotId`; a tool call whose element id is not from the **latest** snapshot of that window fails with `stale_target` (T12). Tool descriptions are static first-party text. The browser namespace `browser.*` (section 7) has the same shape.

**Open policy conflict.** The adapter mount today makes **every MCP call ask first** (header of `mcp-mount.mjs`: no auto-approve switch). For the driver that would be a prompt per click and would be unusable, while "grant = approval for benign classes" is the point of this design. Recommendation: do not change the third-party rule; mark the driver as first-party with its own gate, and keep the mount's always-ask rule for every other server. See Q2.

## 6. Per-OS capability reality

Rows marked **P** are backed by the Phase 0 probe in this repo; **K** means general platform knowledge not checked here (verify in P7.2).

### macOS (first, ship first)

| Capability | Reality | Basis |
|---|---|---|
| Read UI | The Accessibility API requires the user to enable the app in Privacy and Security, Accessibility. `AXIsProcessTrusted()` is the check; untrusted yields `permission_denied`, as the Phase 0 probe saw. | P (`ax_probe.rs`, report) |
| Which process holds the permission | The permission is per code identity. A rebuilt or re-signed binary with a different identity loses it, so the dev and release signing identity must be stable; helper binaries inside the bundle are the safest place for the driver. Whether a sidecar child inherits the parent app's grant needs a test. | K |
| Screenshots | Screen Recording permission is separate, per app. Window-level capture (ScreenCaptureKit) lets the driver capture one window instead of the display. Recent macOS versions re-prompt periodically for continuing capture; the UX must expect revocation mid-session. | K |
| Input injection | Synthesised events need the Accessibility permission. Secure event input (password fields, some apps) blocks them. Events can be tagged with an event-source identity so the shell can tell its own from the user's (4.6). | K |
| Scripting other apps (Apple Events) | A separate Automation permission per target app; out of scope for the first release. | K |
| Secure fields | `AXSecureTextField` role and value withheld by the OS for secure fields. | K |
| Distribution | Hardened runtime and notarisation are required for a normal install; they interact with entitlements for capture. Sandboxed builds cannot drive other apps. The Mac App Store is therefore out. | K |
| Prompts are user-granted only | There is no API to grant them programmatically, which suits this design. | K |

### Windows

| Capability | Reality | Basis |
|---|---|---|
| Read UI | UI Automation works across processes at the same or lower integrity without a permission prompt. A process cannot drive a window of a higher integrity (elevated) app unless it is signed and installed to a secure location with the UI-access flag; **UIPI** otherwise blocks it. The first release treats elevated windows as not grantable. | K |
| Input | `SendInput` is blocked from reaching the secure desktop (UAC prompts, lock screen); those cannot be driven and must not be. | K |
| Capture | The Graphics Capture API captures a window and shows a visible capture border on current Windows 11 builds; older builds differ. | K |
| App identity | Executable path plus Authenticode signer; packaged (MSIX) apps use the package family name. | K |
| Secure fields | `IsPassword` on UIA elements. | K |

### Linux (best effort, last)

| Capability | Reality | Basis |
|---|---|---|
| X11 | Any client can read other windows and inject events with no permission model. **A per-app grant cannot be enforced against an X11 session**: the driver can honour the grant, but nothing stops another process. The honest position is "advisory only on X11". | K |
| Wayland | The compositor forbids global input injection and arbitrary screen capture. The sanctioned route is the desktop portal (screen cast and remote desktop interfaces) with a user prompt per session, and the available features differ per compositor. Emerging input-emulation interfaces are not universal. | K |
| Accessibility tree | AT-SPI over D-Bus; needs accessibility enabled in the session; GTK and Qt expose it, Electron and some toolkits need flags or expose little. | K |
| Webview | The Tauri shell on WebKitGTK is already the weakest graphics target (Tauri plan risks). | P (plan) |

**Position:** macOS fully designed and built first. Windows second, observe and benign input only. Linux: accessibility-tree observation and portal-based, prompt-per-session driving, clearly labelled experimental; on X11, disabled by default because the grant cannot be enforced.

## 7. Browser control

Browser control goes through the Chrome extension, not through desktop accessibility: the extension can scope by **origin**, which a screenshot-and-click path cannot.

- Per-**origin** grants, using the browser's own optional-host-permission request so the browser draws the prompt; never `<all_urls>`. Classes mirror section 4.3 (`read`, `navigate`, `type`, `invoke`, destructive, credential), with form submits, purchases, posts and downloads classed destructive.
- The same shell-owned grant store, indicator, kill switch and audit log: the extension talks to the shell over native messaging (or the loopback core with the shell as arbiter), and the **gate stays in the shell**, because an extension's own state can be altered by a compromised page context.
- Page text is untrusted data; password fields and payment fields are never read or written; no `debugger`-level or cookie access.
- Incognito and the user's profile are separate decisions (Q7).

## 8. Interaction with existing controls

- **Permission modes** (Ask, Accept Edits, Bypass) do not apply: the gate is stricter and separate. Bypass does not skip approvals here.
- **Workspace Trust** still decides which MCP stdio servers start; the driver is not one of those servers.
- **Extensions catalog** switches can hide the driver per user and per project; a restricted mode removes it.
- **Loop, Auto Tasks, jobs:** the job runner refuses any job whose turn would attach `desktop.*` (a static check, plus the gate's `origin` check).
- **Outbound pinning:** the driver makes no network calls; the audit mirror uses the existing server route.

## 9. Test plan

All tests run **without a paid model call**: a scripted fake model emits attacker-chosen tool calls, because the gate, not the model, is what is under test.

| Area | Tests |
|---|---|
| Policy gate (property tests) | No tool call succeeds without a live grant for that app and class; expiry, idle expiry, action count, focus loss and turn change each revoke; `destructive` and `credential` never appear in a grant; unknown role and unlabeled controls classify destructive. |
| Hostile fixture app | A purpose-built local test window with: injection text in labels, titles and a fake notification; a "Delete" button; a password field; a second window of another app; a drag-out item. Scripted attacks must be blocked and logged (T1, T2, T4, T5). |
| Approval integrity | Approval cannot be answered by synthetic input from the driver; timeout resolves deny; a changed target digest voids it; replay of an approval fails (T6, T12). |
| Kill switch | Hotkey, button and lid trigger each stop within 250 ms in a loaded run; a held key and button are released; no event after the trigger; lock-out persists until the click; a crash of the shell or sidecar leaves no driver process (T7). |
| Audit | Chain verifies; edit, delete, reorder and truncation are each detected using the keychain anchor; no secret text, no screenshot content, denied calls present. |
| Egress | A driving turn has no shell, fetch or poster tool; adding one is logged; cross-app taint demands approval (5.2, 5.3). |
| Remote tier | Every relay request class against `desktop.*` and `browser.*` is refused, in every desktop mode including Bypass, and with a grant already live (relay design "permission matrix" gate). Stop is accepted only from the native tier. |
| Schema caps | Tool JSON under 12 000 characters; every result under the 30 000 character cap; element ids from a stale snapshot are rejected. |
| Per-OS | macOS permission states (denied, granted, revoked mid-run) and signing identity stability; Windows elevated-window refusal; Linux X11 "advisory only" banner. GUI runs need real permissions on a real desktop: those are manual `(you)` steps and are listed in the exit gates, not faked in CI. |
| Fuzz | Tool arguments (oversized, wrong type, control characters) and malformed accessibility trees. |

## 10. Phases and exit gates

Default off behind a flag throughout; nothing in P7.0 to P7.1 touches the OS.

| Phase | Scope | Exit gate |
|---|---|---|
| **P7.0 Specify and review** | This design to a frozen spec (grant schema, class table, audit format, tool schemas, remote ceiling clause for the relay R0 spec). | An independent security review of the design signs off; section 12 questions answered; no code before. |
| **P7.1 Policy core with a fake driver** | Grant store, classes, classifier, approvals, kill switch, audit chain and keychain anchor, in the shell, against a fake driver and a scripted model. | Policy, approval, kill, audit and remote-tier tests pass; the permission matrix covers every mode including Bypass. |
| **P7.2 macOS observe-only** | AX tree snapshot and window screenshot of a granted app; per-OS spike confirming section 6 rows marked K; indicator; secure-field blanking. | Hostile-fixture run passes; real macOS run by the user with TCC granted and revoked; screenshots confirmed window-scoped; egress consent flow works. |
| **P7.3 macOS benign input** | `navigate`, `input-benign`, `invoke`, focus rule, human-takeover pause. | Kill latency measured under 250 ms on a real Mac; takeover pause works; stale-target rejection tested. |
| **P7.4 Destructive and handoff approvals** | Approval dialogs, classifier tables, clipboard and handoff classes, taint rule. | Adversarial script corpus fully blocked; independent review of the classifier. |
| **P7.5 Browser** | Extension per-origin grants through the same gate. | Origin-scoping test; no `<all_urls>`; extension review notes. |
| **P7.6 Windows** | UIA observe and benign input, UIPI refusal. | Real Windows run by the user; elevated-window refusal proved. |
| **P7.7 Linux** | AT-SPI observe, portal-driven input, X11 advisory banner. | Marked experimental; X11 off by default. |
| **P7.8 Final review** | External security review of the shipped behaviour (the Tauri plan's Phase 7 gate: "Security review passed"). | Review passed; then the flag may default on for macOS only. |

## 11. Residual risks, stated plainly

- A fully compromised user account can disable the shell's protections and rewrite the audit log; the hash chain and keychain anchor make tampering visible, not impossible.
- The classifier is heuristic. Fail-closed lowers harm but also blocks legitimate actions on custom-drawn controls; that is the intended trade, with `ask_user` as the escape.
- Screenshots go to a third-party model provider unless a local provider is used; consent and window scoping reduce, not remove, this.
- Prompt injection is not solved; this design removes the capabilities an injection would need (other apps, shell, network, credentials, destructive clicks without a human) rather than trying to detect the text.
- On Linux X11 per-app grants are advisory.

## 12. Open questions for you, with recommendations

| # | Question | Recommendation |
|---|---|---|
| Q1 | macOS only for the first release, or all three OSes? | macOS only; Windows after P7.6; Linux experimental. The Tauri plan already ships Mac first. |
| Q2 | Make the driver a **first-party exception** to the mount's "every MCP call asks first" rule (grants stand in for per-call approval on benign classes)? | Yes, only for the first-party driver; keep the always-ask rule for every other MCP server. |
| Q3 | Terminals and shell apps: denylisted (recommended) or grantable with `destructive` for every key? | Denylist in the first release; the chat shell tool already covers command running with its own rules. |
| Q4 | Offer a **stop-only** request from the native iOS app (never the PWA)? | Yes, native tier only, as a typed request class that can only revoke. It reduces risk and is cheap. |
| Q5 | Default grant lifetime 15 minutes, maximum 4 hours, idle 5 minutes: acceptable? | Yes; shorter is safer and a re-grant is one click. |
| Q6 | Screenshots: allowed only with a local or self-hosted provider, or also to the cloud provider after one-time consent? | Allow the cloud provider after consent, but default the grant dialog to `observe-tree` only and make screenshots an explicit tick. |
| Q7 | Browser profile: the user's normal profile, a dedicated profile, or both? | Dedicated profile first (no existing logins to lose), normal profile later with per-origin grants. |
| Q8 | Agent-visible "ask the user to sign in" handoff (4.5) in the first release? | Yes; without it the agent will fail at the first login wall and users will want a credential path. |
| Q9 | Do the relay R0 spec and this design get one **independent review** together, or separately? | Together for the shared clause (remote ceiling and stop-only), separately for the driver. |
| Q10 | Should the audit log be user-deletable? | Yes, with a logged "log cleared" tombstone kept in the keychain anchor; it is the user's data, and the server mirror keeps content-free events. |
