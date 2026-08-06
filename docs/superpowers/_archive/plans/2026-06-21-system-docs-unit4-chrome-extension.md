# System Docs — Unit 4 (Chrome Extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild-grade spec + explanation layer for the Chrome extension (`extension/src/`) — the message protocol, the caption-scraper algorithm + content filters, `chrome.storage` state shapes, the service worker, the shared side-panel/popup bundle, and build/manifest. Also closes the long-deferred `extract_messages` drift (the last red test).

**Architecture:** Reuse the proven template: fix the structured message-protocol extractor first (closing the deferred drift), then write `docs/spec/chrome-extension.md` section-by-section with verified `file:line` citations, then a concise explanation page cross-linked to the existing `caption-capture.md`. Harvest heavily from `explanation/invariants.md` (which already holds the operational MUST/MUST-NOT rules for these files).

**Tech Stack:** React 18 + TS + Vite + `@crxjs/vite-plugin`, Manifest V3; Python extractors under `docs/_scripts/` (pytest via `python3`); mkdocs NOT installed (verify structurally).

---

## Scope
Implements unit #4 of [`2026-06-21-layered-system-docs-design.md`](../specs/2026-06-21-layered-system-docs-design.md). Out of scope: units #5–6, and the unit-1 OpenAPI schema sweep.

## Source map
| Area | Files |
|---|---|
| Message protocol | `extension/src/lib/messages.ts` (`MsgType` enum + `Message` union + `isMessage`) |
| Caption capture | `extension/src/content/caption-scraper.ts`, `speaker-detector.ts`, `floating-overlay.ts` |
| Platform detection | `extension/src/lib/platforms.ts` |
| Service worker | `extension/src/background/service-worker.ts` |
| Client state | `extension/src/lib/storage.ts`, `config.ts` |
| Side panel / popup | `extension/src/sidepanel/{main.tsx,App.tsx,index.html}`, `sidepanel/hooks/*`, `sidepanel/components/*` |
| Other lib | `extension/src/lib/{anthropic,kb,entities,export-formats,plan}.ts` |
| Build | `extension/vite.config.ts`, `extension/manifest.json` |

## File structure
| File | Responsibility | New? |
|---|---|---|
| `docs/_scripts/test_extract_messages.py` | Update stale expected MsgType set + payloads to reality | modify |
| `docs/reference/message-protocol.md` | Regenerated from messages.ts | regenerate |
| `docs/spec/chrome-extension.md` | Rebuild-grade spec | create |
| `docs/spec/.pages` | Add `chrome-extension.md` to nav | modify |
| `docs/explanation/chrome-extension.md` | Explanation-layer orientation | create |
| `docs/explanation/caption-capture.md` | Add cross-link to spec | modify |

---

## Task 1: Close the `extract_messages` drift (last red test)

**Files:** modify `docs/_scripts/test_extract_messages.py`; regenerate `docs/reference/message-protocol.md`.

**Verified background:** `extract_messages.py` reads `extension/src/lib/messages.ts` → writes `docs/reference/message-protocol.md`. `test_extract_messages.py:54` asserts the MsgType member set equals a fixed set, but the real enum has more members (e.g. `GET_CAPTION_STATUS`, `PING`, `OPEN_POPUP`, `CAPTION_SCRAPER_READY`, `ACTIVE_SPEAKER`, `PARTICIPANTS_LIST`, `POST_CHAT`, …). The test also asserts payload field sets for `CAPTION_FINAL` and `CAPTION_STATUS`.

- [ ] **Step 1 — Establish ground truth.** Read `extension/src/lib/messages.ts` fully: list every `MsgType` member and, from the `Message` union, the payload fields for `CAPTION_FINAL` and `CAPTION_STATUS` (and note the routing direction comments the extractor parses). Run `python3 docs/_scripts/extract_messages.py` and read the regenerated `docs/reference/message-protocol.md`. Run `python3 -m pytest docs/_scripts/test_extract_messages.py -v` and capture the exact failing assertion(s). Report the real member set vs. the test's expected set.

- [ ] **Step 2 — Update the test to reality.** In `test_extract_messages.py`, correct the `assert set(members.keys()) == {…}` to the real member set. Verify (do not blindly trust) the payload assertions at lines ~96–97: `CAPTION_FINAL == {speaker, text, timestamp, sessionId}` and `CAPTION_STATUS == {active, platform}` against the real union — if the union differs, update them to match source. Keep the ordering assertions (lines ~85–86) if still valid; adjust if member order changed. Do NOT weaken the test to a trivial check — it must still assert the true, specific member set and payloads.

- [ ] **Step 3 — Run green.** `python3 -m pytest docs/_scripts/test_extract_messages.py -v` → all PASS.

- [ ] **Step 4 — Full gate.** `python3 -m pytest docs/_scripts/ -q` → expect **0 failures** now (this closes the last known-red test).

- [ ] **Step 5 — Commit:**
```
git add docs/_scripts/test_extract_messages.py docs/reference/message-protocol.md
git commit -m "docs: fix message-protocol drift (real MsgType set + payloads)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `docs/spec/chrome-extension.md` — message protocol + caption scraper

**Files:** create `docs/spec/chrome-extension.md` (sections 1–3); modify `docs/spec/.pages`.

**Accuracy rule:** state only source-verified facts; cite real `file:line` (confirm before citing). Link generated reference pages; do not paste large code blocks where a cite + the exact constant/regex will do.

- [ ] **Step 1 — Frontmatter + §1 Scope.** `---\ntitle: Chrome extension — spec\nstatus: draft\n---`. List governed files (Source map above; `ls extension/src/**` to confirm).

- [ ] **Step 2 — §2 Message protocol.** Link the generated [`../reference/message-protocol.md`](../reference/message-protocol.md). State the contract from `lib/messages.ts`: the full `MsgType` enum, that the `Message` union is strongly typed per variant, that caption messages MUST carry `sessionId`, and that listeners take `unknown` + the `isMessage()` guard (never `any`). Give the exact payload shapes for `CAPTION_FINAL` and `CAPTION_STATUS`. Cite file:line.

- [ ] **Step 3 — §3 Caption-scraper algorithm (rebuild-grade).** From `content/caption-scraper.ts`, document exactly: `SCRAPE_INTERVAL_MS = 800`, the session-gap rule (`SESSION_GAP_MS`, new session on first sight OR >5s silence), `MAX_BLOCK_AGE_MS`, the per-speaker state map shape, the "emit only when text changes" rule, the `seenSpeakers` one-block-per-speaker rule, and content-based validation. Enumerate the **content filters** (the named regex/pattern constants — `MATERIAL_ICON_PATTERN`, `CLOCK_PATTERN`, `MEET_UI_PATTERNS`, `GROUP_ICON_RE`, `COMBINED_SPEAKER_RE`/`_JA`, `ICON_PATTERN`, etc.) with what each rejects — quote the real constant names and a representative pattern. Document `detectPlatform()` dispatch (`lib/platforms.ts`) and per-platform readers (Meet/Teams `data-tid="closed-caption-*"`/Zoom), and the `sanitizeLine()` injection-fence stripping. Cite file:line throughout. Note the hybrid fallback to Web Speech API on unsupported pages.

- [ ] **Step 4 — Add to nav.** `docs/spec/.pages`: add `- chrome-extension.md` after `- agent-runtime.md`.

- [ ] **Step 5 — Verify + commit.** Links resolve; re-open a few cites.
```
git add docs/spec/chrome-extension.md docs/spec/.pages
git commit -m "docs: chrome-extension spec part 1 — message protocol + caption scraper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `docs/spec/chrome-extension.md` — storage, worker, panel, build

**Files:** modify `docs/spec/chrome-extension.md` (append sections 4–8 + regen checklist).

- [ ] **Step 1 — §4 Client state (`chrome.storage.local`).** From `lib/storage.ts` + the hooks: the `SavedTranscript` shape (must include raw `segments`, not just rendered string), `MAX_TRANSCRIPTS = 50`, `MAX_SEGMENTS = 5000` (confirm in `useTranscript`), the `chatMessages` key + no-retention-cap rule, speaker-name persistence, and the 5 MB quota constraint. List the actual storage keys used. Cite file:line.

- [ ] **Step 2 — §5 Service worker (`background/service-worker.ts`).** Auto-inject content scripts via `chrome.scripting.executeScript` reading paths from `chrome.runtime.getManifest().content_scripts[].js` (never hardcoded — hashed per build), the `PING` pre-check, the post-injection delay before first `START_CAPTION_SCRAPING`, and the single-`onMessage`-listener rule. Cite file:line.

- [ ] **Step 3 — §6 Side panel + popup.** The shared-bundle contract (ADR-0010): popup (`chrome.windows.create({type:'popup'})`, 420×680) mounts the SAME bundle as the side panel and syncs via `chrome.storage.local` + `chrome.runtime.onMessage` — no forked tree. The LLM-hook contracts (`hooks/*`): every hook takes a `language?` param and threads it; AbortController on every request (cancel-on-unmount/clear); timeout-vs-user-cancel distinction; strict response-shape validation; the `REQUIRED_ENDPOINTS` + stale-server banner. Cite file:line. Link [`api-server.md`](api-server.md) for the endpoints consumed.

- [ ] **Step 4 — §7 Server URL safety + config (`lib/config.ts`).** `isSafeServerUrl()` accepts only localhost/127.0.0.1/[::1] (+ optional port); `getServerUrl()` strips trailing slashes; `setServerUrl()` throws on unsafe. The timeout constants (`HEALTH_CHECK_TIMEOUT_MS` short vs `REQUEST_TIMEOUT_MS` long). Cite file:line.

- [ ] **Step 5 — §8 Build & manifest.** Vite + `@crxjs/vite-plugin` (content-script paths hashed, read from manifest at runtime), Manifest V3 (service worker, not background page), Chrome ≥ 114 (side panel API), `npm run build` must be `tsc --noEmit` clean. Cite `extension/vite.config.ts` / `manifest.json`.

- [ ] **Step 6 — §9 See also + regen checklist.** Link `../explanation/chrome-extension.md`, `../explanation/caption-capture.md`, `../explanation/invariants.md`. Append the ticked regeneration checklist (copy the format used in `docs/spec/agent-runtime.md`, with a spot-check line naming the caption-scraper constants + message protocol + storage shapes).

- [ ] **Step 7 — Commit:**
```
git add docs/spec/chrome-extension.md
git commit -m "docs: chrome-extension spec part 2 — storage, worker, panel, build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Explanation page + cross-links + final gate

**Files:** create `docs/explanation/chrome-extension.md`; modify `docs/explanation/caption-capture.md`.

- [ ] **Step 1 — Create `docs/explanation/chrome-extension.md`.** Concise orientation (explanation altitude, no exact constants): what the extension surface is (content script → service worker → side panel/popup), the capture→ingest→AI flow from the browser's side, the shared-bundle idea, and the hybrid CC/mic capture stance. Frontmatter `title: Chrome extension`, `status: draft`. Add the admonition:
```markdown
!!! info "Rebuild-grade detail"
    Exact contracts (message protocol, caption-scraper constants/filters, storage shapes, service worker, build) are in [`../spec/chrome-extension.md`](../spec/chrome-extension.md).
```
Link `caption-capture.md` for the deep caption narrative and `../explanation/invariants.md` for the operational MUST/MUST-NOT rules.

- [ ] **Step 2 — Reciprocal link.** In `docs/explanation/caption-capture.md`, add a one-line "See also: [`spec/chrome-extension.md`](../spec/chrome-extension.md) — rebuild-grade contracts" near the top.

- [ ] **Step 3 — Final gate.** Run + paste:
```
python3 -m pytest docs/_scripts/ -q     # expect 0 failures (drift closed in Task 1)
python3 docs/_scripts/check_api_coverage.py && python3 docs/_scripts/check_rate_limit_mapping.py
```
Plus a link-check over `docs/spec/chrome-extension.md` + `docs/explanation/chrome-extension.md` (normpath each relative link, assert exists). Paste the result.

- [ ] **Step 4 — Commit:**
```
git add docs/explanation/chrome-extension.md docs/explanation/caption-capture.md
git commit -m "docs: chrome-extension explanation page + cross-links

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review
- **Spec coverage:** design-spec unit-4 items (MsgType enum + payloads, caption-scraper algorithm + filters, chrome.storage shapes, service worker, build) → Task 1 (protocol drift + reference), Task 2 (protocol + scraper), Task 3 (storage/worker/panel/config/build). ✓
- **Placeholder scan:** Task 1 has concrete TDD steps; spec-page steps give exact sections + source files + the named constants/regexes to verify + the ticked regen checklist. ✓
- **Name consistency:** `extract_messages`, `chrome-extension.md`, `SCRAPE_INTERVAL_MS=800`, `MAX_TRANSCRIPTS=50`, `MAX_SEGMENTS=5000`, `isSafeServerUrl` used consistently. ✓
- **Risk note:** the caption-scraper filter constants and storage caps must be re-verified from source in Tasks 2–3, not carried from `invariants.md` prose (which may itself have drifted).
