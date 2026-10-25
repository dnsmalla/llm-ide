# Plan: Tauri desktop app + relay (multi-platform LLM-IDE)

**Status:** Future plan — direction agreed, not scheduled. Work starts with Phase 0
only when it is explicitly picked up; until then, current work continues on the
existing Swift app and Node server.
**Date:** 2026-10-24
**Decision record:** [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md)

## 1. Goal

One LLM-IDE that runs on **macOS, Windows and Linux**, keeps the desktop app as the
**main worker**, and lets the phone and Chrome extension keep working (read + queue)
when the desktop is off — under **one company LLM bill**.

### Success criteria

| # | Criterion | Measured by |
|---|---|---|
| S1 | Same desktop app ships for macOS, Windows, Linux from one codebase | CI release matrix green on all three |
| S2 | Desktop is as fast as or faster than the Swift app on the views that matter | Phase 0 benchmark table (§6) |
| S3 | Phone + extension read the latest notes/plans/issues while the desktop is off | Manual test: quit desktop → phone still shows data |
| S4 | Requests made while the desktop is off run when it returns | Queue a chat/task with desktop off → result appears after restart |
| S5 | One LLM bill, per-user spending caps | Console workspace + `usage_ledger` caps enforced |
| S6 | No regression of security invariants (`docs/explanation/invariants.md`) | `make regression` + security checklist |

### Non-goals

- Forking VS Code or building a general-purpose code editor.
- A hosted multi-company SaaS.
- Rewriting the agent engine or server in Rust.
- Sharing one personal Claude Pro/Max subscription between people (prohibited by
  Anthropic's terms; see §5).

## 2. The rule that decides where every line of code goes

| Kind of code | Language / place | Why |
|---|---|---|
| **Business logic** (chat state, Loop, Auto Tasks, Library ingest, issues, plans) | **TypeScript, in the Node core** (`extension/`) | Agent SDK is TS; one implementation serves desktop, phone, extension |
| **UI** | **TypeScript + React**, one shared component kit | Same UI in desktop (Tauri webview), phone (PWA), extension |
| **OS access + heavy compute** (window, tray, keychain, file watch, PTY, accessibility capture, desktop control, graph layout if needed) | **Rust**, inside the Tauri shell | Native speed, native APIs, cross-platform crates |

Rust is used **only** for performance and platform access. If a piece of code is
neither, it is TypeScript.

## 3. Target architecture

```
┌──────────────────────── Desktop app (MAIN WORKER) — Tauri 2 ───────────────────────┐
│  UI: React + TypeScript (Monaco editor, xterm.js terminal, WebGL graph)            │
│  Rust shell: window/tray/menus, keychain, PTY, file watcher, accessibility capture,│
│              desktop control, updater, graph layout (only if Phase 0 says so)      │
│  Node core (sidecar process): existing server — agent engine, KB/SQLite, vault,    │
│              connectors, MCP, plugins, Loop + Auto Tasks (moved from Swift)        │
│  Holds the company LLM API key. Publishes snapshots, drains the inbox.             │
└───────────────▲──────────────────────────────────────────────▲─────────────────────┘
                │ localhost (same machine)                     │ outbound HTTPS/WebSocket
        Chrome extension                         ┌─────────────┴──────────────┐
        (local core when present,                │ Relay (always on, small)   │
         relay when not)                         │  TypeScript service        │
                                                 │  snapshots/ (encrypted)    │
                                                 │  inbox/     (requests)     │
                                                 │  serves the phone PWA      │
                                                 │  NO LLM calls, NO code exec│
                                                 └─────────────▲──────────────┘
                                                               │ HTTPS
                                                   Phone (PWA) · extension (remote)
```

### What works in each state

| State | Desktop | Phone / extension |
|---|---|---|
| Desktop on | Everything | Everything live (requests pass through the relay) |
| Desktop off | — | Read latest snapshots; queue requests; extension records meetings and uploads |
| Relay down | Everything locally | Extension on the same machine still uses the local core; phone offline |

## 4. Technology choices

| Need | Choice | Replaces (Swift app) |
|---|---|---|
| App shell | **Tauri 2** (WKWebView / WebView2 / WebKitGTK) | SwiftUI shell |
| UI framework | React 19 + Vite (already used by the extension) | SwiftUI views |
| Code editor | **Monaco** (already embedded via `Core/Editor/MonacoHost.swift`) | WKWebView host |
| Terminal | **xterm.js** + Rust `portable-pty` | SwiftTerm |
| 2D/3D code graph | WebGL (three.js / sigma.js); layout from graph-kit's existing **TypeScript** implementation, moved to Rust (native or WASM) only if Phase 0 misses targets | SceneKit `Graph3DView` + Swift `GraphCore` layout |
| Node runtime | Node core shipped as a **sidecar** (`externalBin`), packaged as a Node single-executable app | `BackendManager` child process |
| Secrets | Rust `keyring` (Keychain / Credential Manager / Secret Service) | `KeychainStore` |
| Auto-update | `tauri-plugin-updater` (signed) | Sparkle |
| Meeting capture | Rust accessibility: macOS AX, Windows UI Automation, Linux AT-SPI (best-effort) | Swift AX capture |
| Desktop control (later) | Rust: accessibility tree first, screenshots + input (`enigo`, `xcap`) as fallback, exposed as MCP tools | — |
| Relay | TypeScript service (Node on a small VPS, or Cloudflare Workers + R2) | Swift `MobileWebSocketServer` on :3006 |
| Phone | **PWA** served by the relay | Native iOS app (kept until PWA parity, then optional) |

## 5. LLM billing: one bill for everyone

- **Use one company API key** (Claude Console workspace), stored in the desktop vault.
  Every user's request runs through the desktop, so the key never reaches a phone or
  browser.
- **Do not** share one Claude Pro/Max login across people, and do not offer
  `claude.ai` login to other users through the Agent SDK — both are against
  Anthropic's terms. A Claude Team/Enterprise plan (one seat per person) is the
  alternative if per-seat pricing is preferred.
- **Cost controls** (most already exist; tighten and enforce):
  - per-user daily/monthly caps on `usage_ledger` + model limits;
  - tier routing (`server/tier-routing.mjs`): Haiku for classify/summarize/extract,
    Sonnet by default, Opus only for planning and hard coding tasks;
  - stable system prompt for prompt caching (keep the existing guard);
  - answer from the knowledge base first when search already answers the question;
  - Console workspace spend limit as the hard stop.

## 6. Phase 0 — Proof of concept (2–3 weeks): approve or stop here

Build a throwaway Tauri app that hosts the **existing** Node core and three of the
hardest views. Measure against the current Swift app on the same Mac, and on one
Windows machine.

| Test | Go if |
|---|---|
| Cold start to usable window | ≤ Swift app + 0.5 s |
| Idle memory (shell + webview + Node core) | ≤ 1.3 × Swift app |
| Code graph, 10k nodes / 30k edges | ≥ 60 fps pan/zoom on Mac, ≥ 30 fps on Windows; **no edge pruning** (invariant) |
| Code graph, 50k nodes | ≥ 30 fps on Mac |
| Monaco typing latency, 10k-line file | < 16 ms per keystroke |
| Terminal: `yes \| head -1000000` | No UI freeze > 100 ms |
| Chat streaming (long v2 turn) | No dropped/duplicated events vs Swift client |
| Node sidecar packaging | Starts, finds `claude`, survives app quit/restart on Mac + Windows |
| Installer size | ≤ 150 MB per platform |
| Meeting capture via Rust AX (macOS) | Reads Zoom/Teams captions at the existing 800 ms cadence |

**Exit:** a one-page benchmark table. All rows pass → approve Phase 1. Graph rows fail
→ re-run with Rust/WASM layout. Any other row fails badly → stop; keep Swift on macOS
and use Tauri only for Windows/Linux.

## 7. Phases after approval

Effort assumes 1–3 engineers with AI assistance; treat as relative size.

| Phase | Scope | Size | Exit gate |
|---|---|---|---|
| **1. Core contract** | OpenAPI/JSON-RPC spec generated from `ALL_ENDPOINTS`; contract tests in CI for every client; streaming events typed | 3–4 wk | Swift app + extension pass contract tests |
| **2. Move logic out of Swift** | Move to the Node core, in order: chat session state, Library ingest, Issues, Loop + Auto Tasks (≈ 33k Swift lines of Loop/AutoTask logic). Swift app calls the core for each moved piece | 8–12 wk (overlaps 3) | Swift app works unchanged on the new core paths |
| **3. Tauri desktop: Chat + Explorer + Library** | Shared React UI kit; Monaco, xterm.js, file tree, settings | 6–8 wk | Daily use on Mac + Windows; S1 partially met |
| **4. Relay + phone PWA** | Snapshots (end-to-end encrypted), inbox, device enrollment by QR code from the desktop, push notifications | 4–6 wk | S3 + S4 pass |
| **5. Remaining views** | Code graph, Loop/Auto Tasks UI, Issues/Gantt, Doc Gen, Live capture (Mac → Windows → Linux) | 8–10 wk | Feature parity checklist on macOS |
| **6. Retire Swift** | One release with both apps; then Swift app → maintenance; native iOS app optional | 2 wk | S1–S6 all pass |
| **7. Desktop + browser control** | MCP tools on the desktop (accessibility first) and extension (browser) with per-app grants, audit, kill switch | 4–6 wk | Security review passed |

First usable cross-platform build: end of Phase 3 (~4–5 months). Full parity: ~9–12 months.

### Swift → new home, by size

| Swift area | Lines | Logic goes to | UI goes to |
|---|---|---|---|
| Core | 40.6k | Node core / Rust shell (keychain, repo, notes) | React kit |
| Chat | 24.1k | Node core (v2 engine already there) | React |
| Loop | 23.0k | **Node core** | React |
| Library | 12.1k | Node core | React |
| AutoTask | 9.7k | **Node core** | React |
| MobileControl | 7.0k | Relay (replaced, not ported) | PWA |
| CodeGraph | 6.2k | graph-kit TS (Rust if needed) | WebGL |
| Others (Settings, Issues, Generation, Explorer, Live, SourceControl, Search, Terminal, …) | ~24k | Node core / Rust | React |

## 8. Security requirements (all phases)

- Core stays bound to `127.0.0.1`; only the relay is reachable from the internet.
- Relay never sees plaintext: the desktop encrypts snapshots with a team key that is
  handed to devices at QR enrollment; revoking a device rotates the key.
- Devices hold individual, revocable tokens; inbox requests are re-checked against the
  desktop's own permission rules (Ask / Accept Edits / Bypass, prefix rules) before
  anything runs.
- The relay runs no LLM calls and no code.
- Signed builds and signed updates on every platform; plugins hash-pinned.
- Workspace Trust: untrusted folders run no hooks, install scripts or MCP stdio servers.
- Desktop control (Phase 7): explicit per-app grant, visible "agent is driving"
  indicator, kill switch, full audit log.

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Linux WebKitGTK WebGL is slower | Graph view sluggish on Linux | Phase 0 measures it; Rust/WASM layout; reduced-detail render mode |
| Node sidecar adds memory | Higher idle RAM | Phase 0 gate; lazy engine load already exists |
| Accessibility capture differs per OS | Live capture weaker on Windows/Linux | Ship Mac first; Linux best-effort; extension capture covers browser meetings |
| Moving Loop/AutoTask logic breaks behaviour | Regressions | Move behind the contract tests; Swift app uses the new path first |
| Two desktop apps during migration | Double maintenance | Freeze Swift features at Phase 1; time-box overlap to one release |
| API-key cost is higher than personal subscriptions | Budget | Per-user caps, model routing, caching; Console spend limit |

## 10. Decisions needed to approve

1. Approve **Phase 0** (2–3 weeks) as a go/no-go proof of concept.
2. Relay hosting: **small VPS (Node)** or **Cloudflare Workers + R2**.
3. LLM billing: **company API key** (recommended) or Claude Team/Enterprise seats.
4. Feature freeze on the Swift app from Phase 1 onward.
