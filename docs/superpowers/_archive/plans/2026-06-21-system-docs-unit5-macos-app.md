# System Docs — Unit 5 (macOS App) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild-grade spec + explanation layer for the macOS SwiftUI app (`mac/`) — app structure & lifecycle, the service taxonomy + key service contracts, server IPC, the platform-coupling boundary (the porting story), the Accessibility capture pipeline, and build/packaging.

**Architecture:** Reuse the per-unit template. NOTE: unlike the JS/Python units there is **no extractor/pytest harness for Swift**, so this unit has no automated drift guard — the spec's accuracy rests on source-verified `file:symbol`/`file:line` citations and controller spot-checks. The spec links [`api-server.md`](../spec/api-server.md) / `openapi.yaml` as the authority for the server routes the app consumes (rather than re-specifying them).

**Tech Stack:** SwiftUI, Swift 5.9, SwiftPM, macOS 14 (Sonoma)+; deps Yams 5.1, Sparkle 2.6, SwiftTerm 1.2, graph-kit 1.2; links system `sqlite3`. Docs: mkdocs (NOT installed locally — verify structurally).

---

## Scope
Implements unit #5 of [`2026-06-21-layered-system-docs-design.md`](../specs/2026-06-21-layered-system-docs-design.md). Out of scope: unit #6, and the unit-1 OpenAPI schema sweep. The app is large (~439 files); the spec documents **contracts and boundaries**, not every file (per-file navigation is the `.code-notes`/source's job).

## Source map
| Area | Files |
|---|---|
| Entry / lifecycle | `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`, `Views/ContentView.swift`, `Views/AppShell.swift` |
| Server IPC | `Services/LlmIdeAPIClient.swift` + `LlmIdeAPIClient+*.swift` extensions, `Services/SessionStore.swift` |
| Services taxonomy | `Services/*` (`*Store`/`*Service`/`*Client`/`*Manager`/`*Mirror`/`*Router`) |
| Capture (AX) | `Services/CaptionScraper/{AXCaptionReader,ZoomCaptionScraper,TeamsCaptionScraper}.swift`, `Services/PermissionsService.swift` |
| Platform coupling | Keychain (`Services/KeychainStore.swift`), AppKit panels (11 files), `NSEvent` (`Views/AppShell.swift`), `Process` (`Services/BackendManager.swift`), terminal (`Views/Terminal/*` via SwiftTerm), Sparkle (`Services/UpdateService.swift`) |
| Build / packaging | `mac/Package.swift`, `mac/build_app.sh`, `mac/LlmIdeMac.entitlements` |

---

## Task 1: `docs/spec/macos-app.md` — structure, services, server IPC

**Files:** create `docs/spec/macos-app.md` (sections 1–4); modify `docs/spec/.pages`.

**Accuracy rule:** state only source-verified facts; cite real `file:line` or `file:symbol` (open + confirm before citing). The app is large — read the named files, don't guess. If a symbol can't be found, say so in the report rather than inventing.

- [ ] **Step 1 — Frontmatter + §1 Scope.** `---\ntitle: macOS app — spec\nstatus: draft\n---`. List the governed areas (Source map). State the build facts up front: Swift 5.9, SwiftPM, macOS 14+, single executable target `LlmIdeMac`, links system `sqlite3`, deps (Yams/Sparkle/SwiftTerm/graph-kit). Cite `mac/Package.swift`.

- [ ] **Step 2 — §2 App lifecycle.** From `LlmIdeMacApp.swift`: the `@main App` struct, the window/scene shape (single `Window(id:)` vs WindowGroup — confirm), the EnvironmentObject graph injected at root (list the real `@StateObject`/`.environmentObject` instances), the `.task` bootstrap sequence (what runs at launch and in what order), and `MenuBarExtra` if present. `ContentView` auth routing (Login vs AppShell), `AppShell` sections. Cite file:line.

- [ ] **Step 3 — §3 Service taxonomy + key contracts.** Document the suffix taxonomy (`*Store` state, `*Service` logic, `*Client` networking, `*Manager` lifecycle, `*Mirror` live-sync, `*Router` nav) with 2–3 REAL examples each (verify the files exist — `ls Services/`). Then give the contract (purpose + key public methods) for the highest-impact services: `SessionStore` (auth state + token refresh), `BackendManager` (spawn/supervise the Node server), `LiveSessionMirror` (poll live sessions), `KeychainStore`, `CaptionOrchestrator`/`AutoCaptureService`. Cite file:line/symbol.

- [ ] **Step 4 — §4 Server IPC.** From `LlmIdeAPIClient.swift` + its `+Auth/+CodeAssist/+Agent/+KB/+Review/+Export/+Live` extensions: the base URL + `Authorization: Bearer <jwt>` auth, the on-401 refresh-and-retry flow, token storage (access in memory, refresh in Keychain — confirm), the two URLSession configs (short auth timeout vs long LLM timeout — quote values), GET-retry/backoff + `Retry-After` honoring. Document the **Code Assistant pendingTool/toolResult flow** (how a `pendingTool` from `/code-assist` is rendered as an editable diff sheet, approved, and POSTed back keyed by id). For the actual route list the app calls, LINK [`api-server.md`](api-server.md) / `../reference/api/openapi.yaml` rather than re-listing — but name the few routes central to the app (auth, kb/search, code-assist, kb/generate-plan, kb/live*). Cite file:line.

- [ ] **Step 5 — Add to nav.** `docs/spec/.pages`: add `- macos-app.md` after `- chrome-extension.md`.

- [ ] **Step 6 — Verify + commit.** Links resolve; re-open a few cites.
```
git add docs/spec/macos-app.md docs/spec/.pages
git commit -m "docs: macos-app spec part 1 — structure, services, server IPC

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `docs/spec/macos-app.md` — platform coupling, capture, build

**Files:** modify `docs/spec/macos-app.md` (append sections 5–8 + regen checklist).

- [ ] **Step 1 — §5 Platform-coupling boundary (the porting story).** A table of every macOS/Apple-only dependency with `file:symbol` and a portability tag. Verify each in source:
  - Accessibility (`AXUIElement`, `AXIsProcessTrusted`) — `Services/CaptionScraper/AXCaptionReader.swift` (the deepest coupling; capture can't work cross-platform without UIA/AT-SPI equivalents).
  - Keychain (`SecItem*`) — `Services/KeychainStore.swift` (what it stores: refresh tokens, PATs; the accessibility class).
  - AppKit file dialogs (`NSOpenPanel`/`NSSavePanel`) — list the ~11 files (grep to confirm count + names).
  - Global hotkeys (`NSEvent.addLocalMonitorForEvents`) — `Views/AppShell.swift` (which shortcuts).
  - Process/PTY — `Services/BackendManager.swift` (`Process`, signals, `lsof`), terminal via SwiftTerm `LocalProcessTerminalView` (`Views/Terminal/*`).
  - Auto-update — Sparkle (`Services/UpdateService.swift`) — macOS-only, must be replaced for a port.
  - App-support paths (`FileManager.url(for: .applicationSupportDirectory)`) — where state lives.
  Cite file:symbol for each. End with the one-line porting strategy (keep Node server + agent runtime verbatim; re-implement the client shell; abstract these edges).

- [ ] **Step 2 — §6 Capture pipeline (AX).** From `AXCaptionReader.swift` + `ZoomCaptionScraper.swift` + `TeamsCaptionScraper.swift` + `PermissionsService.swift`: how the app walks the Accessibility tree to read Zoom/Teams captions, the per-process AX trust gate (`AXIsProcessTrusted`, requires relaunch after granting), the orchestrator/poll cadence, and how captured utterances reach the server (`/kb/live/*` ingest — link `api-server.md`). Cite file:line. Note this is the macOS analogue of the Chrome caption-scraper ([`chrome-extension.md`](chrome-extension.md) §3).

- [ ] **Step 3 — §7 Build & packaging.** From `mac/Package.swift`, `mac/build_app.sh`, `mac/LlmIdeMac.entitlements`: the SwiftPM manifest (target, resources copied — note the vendored highlight.js + DOCX template + python helper), `build_app.sh` (codesign + DMG), the entitlements keys, and the test target setup. Cite file:line.

- [ ] **Step 4 — §8 See also + regen checklist.** Link `../explanation/macos-app.md`, `../explanation/architecture.md`, and the Chrome capture analogue. Append the regeneration checklist — but ADAPT the last line honestly to note there is no automated extractor guard for the Swift surface (accuracy is by source-verified citation):
```markdown
## Regeneration checklist
- [x] Every governed contract (service interfaces, IPC, platform-coupling points, capture pipeline) is present with verified `file:symbol` citations.
- [x] Every coupling point names its Apple-only API and a portability tag.
- [x] Spot-check: the app lifecycle, the API client auth/refresh flow, and the AX capture path were rebuilt from this page and match source.
- [ ] No automated drift guard exists for the Swift surface (no extractor harness) — re-verify against source when the app changes.
```

- [ ] **Step 5 — Commit:**
```
git add docs/spec/macos-app.md
git commit -m "docs: macos-app spec part 2 — platform coupling, capture, build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Explanation page + cross-links + final gate

**Files:** create `docs/explanation/macos-app.md`; modify `docs/explanation/architecture.md` (the `mac/` surface bullet → cross-link).

- [ ] **Step 1 — Create `docs/explanation/macos-app.md`.** Harvest from `mac/README.md` and `docs/how-to/build-the-macos-app.md` (don't duplicate — link the how-to). Concise orientation (explanation altitude, no line numbers): what the app is (native client on the same local server), the MVVM/service-taxonomy mental model, the Accessibility-based capture stance, and the platform-coupling-at-the-edges principle (core logic portable, edges macOS-only). Frontmatter `title: macOS app`, `status: draft`. Add:
```markdown
!!! info "Rebuild-grade detail"
    Exact contracts (service interfaces, server IPC, platform-coupling table, capture pipeline, build) are in [`../spec/macos-app.md`](../spec/macos-app.md).
```

- [ ] **Step 2 — Cross-link.** In `docs/explanation/architecture.md`, find the `mac/Sources/LlmIdeMac/` surface bullet and add "See [`spec/macos-app.md`](../spec/macos-app.md) for rebuild-grade detail." (Keep the existing bullet.)

- [ ] **Step 3 — Final gate.** Run + paste:
```
python3 -m pytest docs/_scripts/ -q          # expect 0 failures (unchanged — no Swift tests)
python3 docs/_scripts/check_api_coverage.py && python3 docs/_scripts/check_rate_limit_mapping.py
```
Plus a link check over `docs/spec/macos-app.md` + `docs/explanation/macos-app.md` (normpath each relative link, assert exists). Paste result.

- [ ] **Step 4 — Commit:**
```
git add docs/explanation/macos-app.md docs/explanation/architecture.md
git commit -m "docs: macos-app explanation page + cross-links

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review
- **Spec coverage:** design-spec unit-5 items (service contracts, platform-coupling interfaces, server IPC, capture pipeline) → Task 1 (structure/services/IPC), Task 2 (coupling/capture/build). ✓
- **Placeholder scan:** spec steps name the exact files + symbols to verify and the regen checklist; no "see code" placeholders. The route list is LINKED to api-server.md (deliberate, not a gap). ✓
- **Name consistency:** `macos-app.md`, `LlmIdeAPIClient`, `AXCaptionReader`, `KeychainStore`, `BackendManager` used consistently. ✓
- **Honesty note:** the regen checklist explicitly records the absence of an automated Swift drift guard — do not tick that line.
- **Risk:** the early-session macOS exploration may contain inaccuracies; every claim must be re-verified from source in Tasks 1–2, not carried from that report.
