---
title: Engineering invariants
status: stable
---

# Engineering invariants

> Hard-won fixes and architectural rules that must not regress. Read this before modifying any file listed below. When in doubt, add new behaviour alongside — never delete an invariant here without a migration note in the PR.

## Why this exists

Each invariant maps to a previous regression. The *decision* behind it (why the system is this shape at all) lives as an [ADR](../decisions/). This page is the operational checklist; the ADRs are the rationale.

## Caption scraper (`extension/src/content/caption-scraper.ts`)

### ✅ MUST preserve

- **Per-speaker state map** — `speakerState: Map<speaker, { sessionId, text, lastSeen }>`.
- **New session when:** first sighting OR silent >5s (`SESSION_GAP_MS`). That's it.
- **`SCRAPE_INTERVAL_MS = 800`** — one snapshot every 800 ms.
- **Only send when text changes** — if `prev.text === text`, just update `lastSeen`, do NOT emit.
- **`seenSpeakers` in readers** — each platform's reader must return AT MOST ONE block per speaker (the outermost/latest). If nested DOM wrappers contain the same speaker, skip duplicates.
- **Content-based validation, NOT position-based** — `isValidCaption()` checks text against UI patterns. Positions are used only to skip the top toolbar.
- **Strict line count for Meet — but strip the `groups` Material icon first.** Meet renders a `groups` avatar icon on any caption block that combines 3+ active speakers. `innerText` folds the DOM so `groups` shows up either as a leading line OR inline-prefixed on the speaker label. `GROUP_ICON_RE` normalises both shapes before counting lines, then we require exactly 2 cleaned lines (speaker + text). **Do NOT add `groups` to `ICON_PATTERN`** — `\bgroups\b` matches inside real speaker strings and would reject every combined caption.
- **Combined-speaker suffix stripping** — `COMBINED_SPEAKER_RE` (`& N others`) and `COMBINED_SPEAKER_JA` (`他N名`) remove the trailing count in `sanitizeSpeaker()` so the speaker is stored as a single name, not `"真鍋勇介 & 6 others"`.
- **`MAX_BLOCK_AGE_MS = 15_000`** — drop stale speaker state after 15 s of no updates.
- **STOP handler broadcasts `CAPTION_STATUS { active: false, platform }`** — so a freshly mounted popup doesn't think recording is still running.
- **`GET_CAPTION_STATUS` reply** — on demand, reply with the current status so late-mounting contexts (popup opened after recording started) sync up.
- **Prompt-injection-safe text** — `sanitizeSpeaker()` strips control chars (U+0000–U+001F, U+007F) and combined-speaker suffixes from speaker names. The `<<<BEGIN>>>` / `<<<END>>>` prompt-fence delimiters are stripped server-side in `sanitizeForPrompt()` (`extension/core/utils.mjs`), not in the scraper.

### ❌ MUST filter out (historical bug reports)

| Category | Examples | Filter |
|----------|----------|--------|
| Material icon names | `frame_person`, `visual_effects`, `closed_caption` | `ICON_PATTERN` + underscored_lowercase check in `isValidCaption()` |
| Clock/timestamps | `8:41`, `AM`, `09:15 PM` | inline `/^\d{1,2}:\d{2}/` regex in `isValidCaption()` (no named const) |
| Meeting ID | `ume-xkgs-oqf` | inline `/^[a-z]{3}-[a-z]{4}-[a-z]{3}/i` regex in `isValidCaption()` |
| Keyboard shortcuts | `⌘ + d`, `ctrl + h` | `[⌘⌥⇧⌃ctrl]\s*\+\s*[a-z]` regex |
| Meeting info popup | `Dial-in`, `PIN:`, `Your meeting's ready`, `close Close` | `UI_PATTERNS` |
| Phone numbers | `+81 3-4545-0450` | inline `/\+\d{1,3}[\s-]?\d/` regex in `isValidCaption()` |
| Long digit sequences | `669 889 208 1049` | `\d{6,}` without surrounding text |
| Toolbar buttons | `Turn off microphone`, `Open caption settings`, `Live captions`, `Font size` | `UI_PATTERNS` |
| Effects panel | `Reframe`, `Backgrounds and effects`, `Portrait`, `Blur` | `UI_PATTERNS` |

### ❌ DO NOT do these (caused regressions)

- **Do NOT reintroduce `dedupeRepeatedPhrases` or similar text-munging.**
- **Do NOT reintroduce "longest text per tick" or "prefix sentence dropping".**
- **Do NOT restrict scanning to a viewport band** (e.g., `bottom 40%`). Captions move during screen share. Use content filters + generous top-toolbar exclusion.
- **Do NOT rename variables without finding all references.** Historical silent `ReferenceError` from `sentTexts` → `captionBuffers` rename that missed one reference.
- **Do NOT raise minimum caption length above 1.** Short Japanese captions like `はい。` (3 chars) are real.
- **Do NOT tie the scraper to one platform.** Readers dispatch via `detectPlatform()`.
- **Do NOT re-introduce tight coupling to a single `.nMcdL.bj4p3b` selector** — Meet rotates class hashes; we have a cascade of fallbacks.

---

## Speaker detector (`extension/src/content/speaker-detector.ts`)

### ✅ MUST preserve

- **`cleanup()` resets `lastSpeaker = ''`** — otherwise BFCache restores a stale value and the first post-restore turn gets suppressed.
- Still used by mic mode to enrich utterances with active-speaker metadata.

---

## Message protocol (`extension/src/lib/messages.ts`)

### ✅ MUST preserve

- **`MsgType` enum covers ALL message types** — `START_CAPTION_SCRAPING`, `STOP_CAPTION_SCRAPING`, `PING`, `CAPTION_FINAL`, `CAPTION_STATUS`, `GET_CAPTION_STATUS`, `CAPTION_SCRAPER_READY`, `ACTIVE_SPEAKER`, `PARTICIPANTS_LIST`, `ERROR`.
- **`Message` union type is strongly typed** — every variant declares its payload fields.
- **`isMessage()` guard validates `type` is a known `MsgType` enum member** — not just any string.
- **Caption messages must include `sessionId`** — the side panel groups updates into one transcript line by sessionId.

### ❌ DO NOT do these

- **Do NOT use string literals** like `{ type: 'START_CAPTION_SCRAPING' }`. Always use `MsgType.*`.
- **Do NOT accept `message: any` in listeners.** Use `unknown` + `isMessage()` guard so an injected message doesn't crash the app.

---

## Transcript persistence (`extension/src/lib/storage.ts` + useTranscript)

### ✅ MUST preserve

- **`SavedTranscript` shape includes `segments` (raw), not just the rendered string.** Loading a past session must rebuild the live UI exactly — speaker renames, sessionIds, timestamps — so future LLM calls (Generate Notes, Chat, Questions) work on the real data.
- **`saveTranscript()` is called in `stopRecording()`** — auto-persists when `segments.length > 0`. Reads snapshot values from refs (`segmentsRef`, `speakerNamesRef`, `meetingTitleRef`, `elapsedRef`, `primaryLangRef`) so the callback's deps stay minimal.
- **`MAX_TRANSCRIPTS = 50`** — oldest pruned first to stay under chrome.storage.local's 5 MB quota.
- **`loadTranscript()` refuses while recording** — returns `false`; `HistoryView` surfaces that as a flash message.
- **Storage errors are non-fatal** — `.catch(() => {})` on persist; the live UI is the user's source of truth during a session.
- **Type-only import in storage.ts** — `import type { TranscriptSegment }` avoids a runtime cycle with `useTranscript.ts`.

### ❌ DO NOT do these

- **Do NOT store only the rendered transcript string.** Loading a session needs segments to rebuild speaker grouping, subtitle export, etc.
- **Do NOT put segments/elapsed/etc. into `stopRecording`'s useCallback deps.** That re-registers the message listener on every caption, leaking handlers.
- **Do NOT raise `MAX_TRANSCRIPTS` without measuring quota usage on long meetings.**

---

## Side panel hook: useTranscript (`extension/src/sidepanel/hooks/useTranscript.ts`)

### ✅ MUST preserve

- **Session-based segment updates** — when a `CAPTION_FINAL` arrives with the same `sessionId` as the last segment, update in place instead of appending.
- **Speaker name sanitization** — trim, clamp to 50 chars before storing.
- **`MAX_SEGMENTS = 5000` cap** — unbounded growth would crash the panel on multi-hour meetings.
- **Mode ref (`captureModeRef`)** — CC messages only process in `'captions'` mode, mic speech recognition only in `'mic'` mode.
- **`setRecordingSync(bool)` eager sync** — updates both `isRecordingRef.current` and state in the SAME tick. Without this, `captureModeRef` / `isRecordingRef` lag one render and the first caption after Start is dropped.
- **Hybrid mode:** Meet/Teams/Zoom → CC scraper; other pages → Web Speech API on mic.
- **Bilingual mode OPT-IN** (off by default), single language is default.
- **CAPTION_STATUS listener + mount-time `GET_CAPTION_STATUS`** — when the floating popup mounts, it asks the content script whether capture is active and syncs state.
- **`Diagnostics` export** — captionsReceived count + lastCaption timestamp + platform, consumed by Settings tab's Diagnostics grid.

### ❌ DO NOT do these

- **Do NOT recreate the speech recognition callback chain on every render.** Use refs.
- **Do NOT register `chrome.runtime.onMessage` listeners outside `useEffect` with cleanup.** Memory leaks + double handlers.
- **Do NOT forget the `captureModeRef.current === 'captions'` guard** on `CAPTION_FINAL` — otherwise captions leak into mic-mode transcripts.

---

## Side panel hooks: useNotes / useChat / useQuestions (`extension/src/sidepanel/hooks/*.ts`)

### ✅ MUST preserve

- **Every LLM hook accepts a `language?: string` parameter** and forwards it in the request body. `App.tsx` threads `transcript.primaryLang` in.
- **AbortController on every request** — cancel-on-unmount via `useEffect` cleanup; cancel-on-clear for `useNotes`.
- **Distinguish timeout (`AbortError` from setTimeout) vs. user-cancel (`AbortError` from cleanup).** Timeout shows "Request timed out"; user-cancel is silent.
- **Strict validation of response shape** — `typeof data?.notes !== 'string' || !data.notes.trim()` → throw. Never render undefined.
- **Stale-server detection in `useQuestions`** — a `404` on `/generate-questions` surfaces: *"The running server is out of date. Restart `node server.mjs` and try again."* rather than a raw upstream error.
- **`useChat` persists messages to `chrome.storage.local`** and restores on mount so side panel ↔ popup share the conversation.
- **Chat history has NO retention cap.** The user owns their conversation; we persist the full array to `chatMessages`. On `QUOTA_BYTES` errors we surface `quotaWarning` through the hook and render a yellow banner in ChatView — we never silently drop old messages.
- **`MAX_HISTORY = 10` is a PROMPT-SIZE bound, not a storage bound.** It caps how many prior messages travel to `/chat` as context. Do not conflate the two.

### ❌ DO NOT do these

- **Do NOT hardcode `REQUEST_TIMEOUT_MS`.** Import from `extension/src/lib/config.ts`.
- **Do NOT silently swallow the `language` param** in any future LLM hook — add it to the body, or LLM output will regress to English for all non-English users.
- **Do NOT retry on abort** — the user explicitly cancelled.

---

## Side panel App (`extension/src/sidepanel/App.tsx`)

### ✅ MUST preserve

- **`REQUIRED_ENDPOINTS` array + `serverStale` banner** — `checkServer()` parses the health response's `endpoints` array; if any required endpoint is missing OR the field is absent entirely, show a yellow "restart server" banner.
- **Health check every `TIMING.SERVER_HEALTH_CHECK_INTERVAL_MS`** — user sees server state go offline/online without manual refresh.
- **`HINT_DISMISSED_KEY` first-run hint** — dismissible, remembered in `chrome.storage.local`. Only shown when `!isRecording` and not previously dismissed.
- **`handleStart()` clears notes/chat/questions before starting** — a fresh recording should not show stale AI output from the previous meeting.
- **Pop-out sends `OPEN_POPUP`**, which the service worker handles by calling `openMacAppDeepLink()`: it opens a tab to `${serverUrl}/launch-app?to=transcript`, which 302s into the `llmide://` scheme so the native Mac app comes to the front. There is no Chrome `type: 'popup'` window.
- **`language` threaded to every AI consumer** — `notes.generate(..., primaryLang)`, `ExportMenu language={primaryLang}`, `questions.generate(..., primaryLang)`, `chat.sendMessage(..., primaryLang)`.
- **Copy-cmd button** on the offline banner copies `node server.mjs` to clipboard.

### ❌ DO NOT do these

- **Do NOT hardcode the server URL.** Always `await getServerUrl()`.
- **Do NOT pop out without passing `chrome.runtime.getURL(...)`** — hard-coded URLs break on reload.

---

## Service worker (`extension/src/background/service-worker.ts`)

### ✅ MUST preserve

- **Auto-inject content scripts on existing tabs** — `chrome.scripting.executeScript` with file paths read from manifest. Handles the case where the extension is loaded AFTER a meeting tab is open.
- **`PING` health check** before injecting — avoid double-injection.
- **Read script paths from `chrome.runtime.getManifest().content_scripts[].js`** — hashed filenames change every build; never hardcode.
- **200 ms delay after injection** before the first `START_CAPTION_SCRAPING` — gives the script time to register its listener.

### ❌ DO NOT do these

- **Do NOT re-broadcast messages** from the service worker. Content scripts' `sendMessage` reaches the side panel directly. Historical bug: double-sent messages.
- **Do NOT add multiple `onMessage.addListener` calls.** One listener routes all messages; multiples cause `sendResponse` conflicts.

---

## Local server (`extension/server.mjs`)

### ✅ MUST preserve

- **CORS is a strict allowlist** — `chrome-extension://<id>` + `localhost` / `127.0.0.1`. The `Access-Control-Allow-Origin` header echoes the request's `Origin` (never `*`), and is only set when the origin is in the allowlist.
- **Server binds to `127.0.0.1` by default** — a non-loopback `LLMIDE_HOST` is REFUSED at startup unless `LLMIDE_ALLOW_REMOTE=1` is also set (the operator opting into a TLS-terminating proxy). The server itself terminates no TLS.
- **`runClaude()` prefers the user's stored `claude.apiKey`** (per-user, from the encrypted vault) so multi-user deployments bill each user's own Anthropic account; it falls back to the operator's Claude CLI login (`execFile('claude', ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '-p', prompt])` — via `spawnCli` / `CLI_ARG_BUILDERS.anthropic` in `providers.mjs`) when no user key is present. `--setting-sources ''` prevents user/project hooks from injecting into the agent context; `--tools ''` makes the invocation a pure completion. A user-scoped key NEVER silently falls back to the operator CLI on failure — that would misattribute spend.
- **8 MB request body limit** — DoS guard.
- **500 k-char prompt cap** — keeps requests within Claude CLI's comfort zone.
- **`SERVER_API_VERSION` + full `ENDPOINTS` array exposed on `GET /` and `GET /health`** — the client uses this for stale-server detection. Bump `SERVER_API_VERSION` whenever wire format or endpoint list changes.
- **Per-request access log** — `res.on('finish', () => console.log(...))` so user sees method, path, status, duration in the terminal.
- **`LANGUAGE_NAMES` + `resolveLanguage()`** — maps UI codes (`ja`, `en-US`, `zh-CN`, `ko-KR`, `es-ES`, `fr-FR`, `de-DE`, etc.) to a human name and a directive string. Falls back via `code.split('-')[0]`.
- **Every LLM prompt carries a language directive** at the top: *"Always respond in ${name}, even if the user writes in a different language."* Covers `/generate-notes`, `/chat`, `/generate-questions`, `/generate-docx`.
- **`/generate-questions` localized H2 headings** — `HEADING_LABELS` for 日本語 (対立 / 要確認 / 要説明), 中文, 한국어, Español, Français, Deutsch. English is the fallback.
- **Prompt injection fences** — all user content is wrapped between `<<<BEGIN>>>` and `<<<END>>>` delimiters; user content is sanitized to strip those delimiters before injection.
- **Empty-after-sanitize guard** on every POST — reject with 400 rather than call Claude with empty input.
- **RFC 5987 Content-Disposition** — `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}` for non-ASCII meeting titles (Japanese 議事録.docx etc.).
- **404 catch-all** that lists real endpoints + a "restart node server.mjs" hint.
- **`server.requestTimeout = 0` (no per-request wall clock).** It was 600 s, sized against the agent loop's old 360 s deadline. Both are gone: an agent turn runs until it finishes or the client cancels, and a socket cut out from under work that is still running gives the user a dead connection instead of an answer — strictly worse than the deadline message it replaced. `headersTimeout` (65 s, slowloris) and `keepAliveTimeout` (60 s, idle sockets between requests) stay: neither can interrupt an in-flight request.

### ❌ DO NOT do these

- **Do NOT add wildcard `Access-Control-Allow-Origin: *`.** Any site on the user's network could call the local server and steal transcripts.
- **Do NOT reintroduce a wall-clock deadline on agent work** — not `requestTimeout`, not a **per-route budget in `server/route-timeout.mjs`** (its map is for short externally-bounded routes only; an LLM or data-scaling route must have no entry), not `deadlineMs` at a call site, not `timeoutIntervalForResource` on the Mac's `llmSession`, not a watchdog on a spawned CLI/build. Every one of those existed, every value was wrong for somebody, and the symptom was a user losing a complete multi-step turn or a long build to `_(reached the Ns deadline — try again)_` — where retrying costs more time and tokens than finishing would have. Bound work by **progress** (`maxIterations`, `MAX_LOOP_DEPTH`, `consecutiveFailureStop`), by **user cancellation**, and by **resource pressure** (`ResourceGuardService` on the Mac side).

  **Hang breakers are not deadlines, and must stay.** A stalled socket or a wedged child produces no bytes and no error, so with no ceiling at all the app hangs with nothing to report — the failure this whole change set exists to prevent. Each is set far above any real workload and named as such: `SOCKET_HANG_BREAKER_MS` (30 min, Anthropic fetch + stream), `CLI_TIMEOUT_MS` (30 min — a CLI child also holds one of six `cliSemaphore` slots, so a wedged one must not retire it forever), `llmCfg.timeoutIntervalForRequest` (2 h of total silence; it is an IDLE timer, reset by every streamed chunk), and git's `http.lowSpeedLimit`/`lowSpeedTime` (~1 KB/s for 5 min — a throughput stall detector, so a slow but progressing clone is never aborted). Raising one is fine; deleting one is not.

  **A resource stop is not a failure.** `VerifyError.stoppedForResources` exists because a guard SIGTERM makes a process exit non-zero, and non-zero is how verification reports "the test failed" — which makes callers dispatch an LLM repair at the exact moment the machine is out of memory. Any new guard integration must distinguish "we killed it" from "it failed". `deadlineMs` remains supported for a caller that opts in deliberately — a probe whose answer is worthless if slow — and short liveness probes (`/auth/*` at 10 s, the backend health ping at 2 s, `headersTimeout`) are not work deadlines and must stay.
- **Do NOT accept an API key as a request parameter or store it unencrypted.** A per-user `claude.apiKey` is allowed ONLY via the encrypted vault (`server/vault.mjs`, AES-256-GCM) and is injected into the agent as `ANTHROPIC_API_KEY` per call — never logged, never echoed in errors (it is redacted), never persisted in plaintext.
- **Keep the Claude CLI fallback working.** When a user has no stored key, `runClaude()` must still work via the operator's `claude -p` login. Direct Anthropic HTTP calls are the per-user-key path, not a replacement for CLI auth.
- **Do NOT remove the language directive** from any prompt. Do not assume English.
- **Do NOT drop the prompt-injection fences.** A hostile participant caption otherwise lets the meeting content rewrite the prompt.
- **Do NOT bump `SERVER_API_VERSION` without also updating `REQUIRED_ENDPOINTS` in `App.tsx`** if endpoints changed.

---

## DOCX export (`extension/server/export-routes.mjs`)

### ✅ MUST preserve

- **Japanese font `MS Gothic`** for CJK support.
- **Claude generates structured JSON first**, then the server fills the DOCX template. Do not merge these steps — merging leaks Claude's reasoning into the file.
- **Input caps** — `MAX_CELL_CHARS = 5_000`, `MAX_CELL_LINES = 200`, `MAX_TITLE_CHARS = 200`. Caps are applied via `capText()` / `capLines()` BEFORE fields reach the docx builder so an oversized response can't blow up Word.
- **Array fields (`decisions`, `todos`, `agenda`, `minutes`, `qa`) defaulted to `['']`** when empty — `docx` crashes on empty cell arrays.
- **Language directive in the JSON-generation prompt** so decisions/todos/minutes come back in the meeting's language.

### ❌ DO NOT do these

- **Do NOT re-import `fs`** — dead import removed; file is streamed in memory.
- **Do NOT bypass `capText` / `capLines`.** Word opens but looks broken if a cell has 50 k chars.

---

## Client library (`extension/src/lib/config.ts`, `extension/src/lib/anthropic.ts`, `extension/src/lib/messages.ts`)

### ✅ MUST preserve

- **`isSafeServerUrl()` accepts ONLY** `http(s)://localhost:3456`, `http(s)://127.0.0.1:3456`, `http(s)://[::1]:3456`. Port must be explicitly present and must be `3456` — URLs without a port (e.g. `http://localhost`) are rejected. The server URL is written to `chrome.storage.local` directly; there is no `setServerUrl()` function. Validation happens on read in `getServerUrl()`, which silently falls back to `http://localhost:3456` for any unsafe or missing value.
- **`getServerUrl()` strips trailing slashes** — request URLs concatenate `${url}/endpoint`, a trailing slash produces `//endpoint` and a 404.
- **`generateMeetingNotes()` signature**: `(transcript, meetingTitle?, participants?, externalSignal?, language?)` — AbortSignal is threaded through so the UI can cancel.
- **`HEALTH_CHECK_TIMEOUT_MS` is short (few seconds)** and `REQUEST_TIMEOUT_MS` is long — don't unify them.

### ❌ DO NOT do these

- **Do NOT accept arbitrary URLs as `serverUrl` in `chrome.storage.local`.** `getServerUrl()` validates on read via `isSafeServerUrl()` and falls back to the default; any unsafe stored value is silently ignored. An attacker-controlled remote URL would be rejected at read time, but never write one deliberately.
- **Do NOT add `http://0.0.0.0`** to the safe list — it's not local on all platforms.

---

## UI / UX / CSS

### ✅ MUST preserve

- **Responsive layout down to 280 px width.**
  - `.app { height: 100vh; display: flex; flex-direction: column }` adapts vertically.
  - `.content { flex: 1; overflow-y: auto }` scrolls independently.
  - `.controls-row { flex-wrap: wrap }` — Start button + language selector stack when narrow.
  - `.tabs { overflow-x: auto; white-space: nowrap }` — 5 tabs horizontally scroll below ~380 px.
  - `.server-offline { flex-wrap: wrap }` — banner buttons drop below message.
  - `@media (max-width: 380px)` and `@media (max-width: 320px)` tighten padding, font size, tab padding, language-select width.
- **Bilingual toggle OFF by default.** Japanese is the default primary language.
- **Capture-mode subtitle** correctly reflects active mode: "Using platform captions (CC)" vs "Microphone mode [· bilingual]".
- **Speaker renaming persists** via `chrome.storage.local`.
- **Settings tab sections:** Microphone selector, Volume boost (50–300 %), Diagnostics grid (recording/platform/captions received/last caption), About/version.
- **First-run hint banner** on the Transcript tab, dismissible, remembered across sessions.
- **`diagnostics-grid`** uses `grid-template-columns: auto 1fr` — key column sizes to content, value column stretches.
- **ExportMenu** accepts `language` prop and forwards to `/generate-docx`.
- **Focus rings** via `:focus-visible` with `outline: 2px solid var(--color-primary)`.

### ❌ DO NOT do these

- **Do NOT ask for microphone permission on side panel load.** Only request on Start Recording AND only when in mic mode.
- **Do NOT show a raw API key input in the side panel Settings.** The optional per-user `claude.apiKey` is managed only through the authenticated credential-vault flow (`/auth` vault endpoints), which encrypts it at rest — it is never entered or held in the side panel UI.
- **Do NOT set fixed pixel widths on any root container.** Must reflow to any width.
- **Do NOT remove `flex-wrap` from `.controls-row`, `.export-menu`, `.export-actions`, `.questions-chip-row`, `.server-offline`.**
- **Do NOT add a horizontal-scroll trap** via `overflow-x: hidden` on `.app`; that breaks the `.tabs` horizontal scroll fallback.

---

## Pop-out → native app

The floating `chrome.windows.create` popup was removed. The pop-out button now sends `MsgType.OPEN_POPUP`; the service worker handles it by opening a tab to `${serverUrl}/launch-app?to=transcript`, which 302s the browser into the `llmide://` custom scheme so the native macOS app comes to the front. Chrome MV3 blocks direct `llmide://` navigation from an extension origin; the server redirect bypasses that restriction.

### ✅ MUST preserve

- **`OPEN_POPUP` handler in service-worker.ts** calls `openMacAppDeepLink()` — do not remove or bypass it.
- **`chrome.sidePanel.open()`** is still called alongside the deep-link so the side panel opens in the same window if it was closed.

### ❌ DO NOT do these

- **Do NOT reintroduce `chrome.windows.create` with `type: 'popup'`.** The floating popup was removed because it created a confusing "second screen" alongside the side panel and the Mac app.
- **Do NOT navigate directly to `llmide://` from extension code** — Chrome MV3 silently blocks custom-scheme navigation from `chrome-extension://` origins.

---

## Build & runtime invariants

- **Vite + `@crxjs/vite-plugin`** — content script paths get hashed; the service worker reads them from the manifest at runtime.
- **`npm run build`** must finish with zero TS errors. Keep `tsc --noEmit` clean.
- **Manifest V3**: service worker, not background page. Do not reintroduce persistent background.
- **Chrome min version**: modern stable (side panel API requires Chrome 114+).
- **Node min version**: 20+ for the local server (uses top-level await, native fetch).

---

## Testing checklist before merging caption / transcript / LLM changes

Run through this against a real meeting before merging:

### Caption fidelity

- [ ] Short Japanese captions (`はい。`, `ハロー！`) appear in transcript
- [ ] Long multi-sentence captions appear as ONE transcript line (not many)
- [ ] Same speaker talking continuously stays on one line (sub-5 s pauses don't split)
- [ ] Different speakers produce different lines with their real Meet names
- [ ] Combined-speaker labels (`& N others`, `他N名`) are stripped to just the speaker
- [ ] UI text does NOT appear: toolbar, clocks, meeting ID, dial-in, effects, CC settings
- [ ] Repeated phrases within a caption are deduplicated
- [ ] CC self-corrections show only the final text, not both versions
- [ ] Works when sharing screen (layout shifts don't break capture)
- [ ] Works when extension is loaded AFTER Meet tab was opened (auto-injection)
- [ ] Works on Teams (`data-tid="closed-caption-*"`) and Zoom web
- [ ] Falls back to mic-based Web Speech API on unsupported platforms

### LLM output

- [ ] Change primary language → Notes heading + bullets come back in that language
- [ ] Change primary language → Chat reply comes back in that language (even if user typed English)
- [ ] Change primary language → Questions H2 headings are localized (対立/要確認/要説明 etc.)
- [ ] DOCX export produces correct font (MS Gothic for JA) and language
- [ ] Stale server (pre–`/generate-questions`) shows the yellow "restart" banner, not a raw 404

### Cross-context sync

- [ ] Start recording in side panel → pop out → popup shows `isRecording: true` and live captions
- [ ] Rename speaker in popup → side panel reflects the rename
- [ ] Chat in side panel → popup shows the same history

### Responsive

- [ ] Side panel at 280 px: tabs horizontally scroll, controls wrap, no clipping
- [ ] Side panel at 420 px: everything fits, no horizontal scroll
- [ ] Side panel maximized: content fills vertically, export buttons wrap cleanly
- [ ] Side panel resized to 300 px: chat input stays pinned to bottom

### Security

- [ ] `GET http://evil.example/` with the extension running does NOT reach the server (CORS)
- [ ] Setting `chrome.storage.local` `serverUrl` to `'http://evil.example'` is rejected by `isSafeServerUrl()` on read; `getServerUrl()` falls back to the default
- [ ] Server terminal shows access log lines for each browser request
- [ ] Meeting with `<<<END>>>` spoken aloud does not break AI output (sanitizer strips it)

---

## SQLite concurrency model (`extension/kb/db.mjs`)

### ✅ MUST understand

- **better-sqlite3 is a single-writer library.** All writes are serialized by the V8 event loop — there is no connection pool and no write concurrency within a single Node process. This is by design and is safe for a localhost server serving one user.
- **WAL mode is enabled.** Readers never block writers and writers never block readers in WAL mode; concurrent read + write is safe as long as there is only one writer process (which is always true here).
- **DO NOT open a second Node process** (e.g. a migration CLI running while the server is up) and write to the same database file at the same time. better-sqlite3 uses synchronous I/O; two writers on the same WAL file will corrupt it.
- **All multi-step mutations must use `db.transaction()`** — for example `mergeTaskMeta()` and `registerUser()`. better-sqlite3 transactions are the only mechanism that provides atomicity + isolation against interleaved event-loop ticks.
- **`getDb()` returns a module-singleton** — the same `Database` instance is reused for the server's lifetime. Do not close and re-open it within a request handler.

### ❌ DO NOT do these

- **Do NOT run `node scripts/backup.mjs` while the server is up without quiescing writes.** The backup script is WAL-aware (`VACUUM INTO`) and safe to run concurrently for reads, but verify before adding writes to the backup path.
- **Do NOT fork child processes that open the DB.** Use the in-process `extension/kb/db.mjs` API from the same event loop instead.
- **Do NOT set `PRAGMA journal_mode = DELETE`** (disables WAL). The WAL pragma is applied by the migration runner on first boot and must not be reverted.

---

## GitHub PR / codegen-apply (`extension/agents/github-pr.mjs`)

### ✅ MUST understand

- **`git push` uses the user's ambient credentials.** The PR flow calls `git push -u origin <branch>` using whatever git config / credential helper the user has set up on their machine (SSH key, HTTPS keychain, etc.). No token is passed to the server; the server never stores one.
- **The working tree must be clean before `openPullRequest()`** — the function now checks `git status --porcelain` and throws if there are uncommitted changes outside `.llmide-auto/`. This prevents codegen-generated files from accidentally staging the user's WIP alongside the auto-generated artifacts.
- **Branch names are prefixed `llmide/auto/<slug>`** — the slug is derived from `taskId` (lowercase alphanumeric + `-_`) so the branch name is deterministic and safe. A branch with the same name existing locally causes an explicit error; the user must delete or rename it before retrying.
- **The function stages ONLY `.llmide-auto/<taskId>/`** — it never stages the rest of the repo.

### ❌ DO NOT do these

- **Do NOT pass a `ghToken` to `execGit` as an env var or argument.** Token handling is GitHub API only (PR creation); git transport uses the system credential helper.
- **Do NOT call `git stash` inside `openPullRequest()`.** Stashing is destructive and non-obvious to the user. Instead, fail fast with the `status --porcelain` check and let the user resolve it.
- **Do NOT remove the branch-exists guard.** Silently force-pushing would clobber work the user may have done on a branch with the same name.

---

## macOS Code Assistant panel (`mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift`, `HistoryTextEditor.swift`)

### ✅ MUST preserve

- **The composer is backed by `NSTextView` (`HistoryTextEditor`), not `TextEditor`.** ↑ / ↓ prompt-history recall is driven from a `keyDown` override — the only point that reliably sees the arrows. SwiftUI's `TextEditor` consumes ↑ / ↓ for caret movement as soon as the field holds text, so `.onKeyPress(.upArrow)` only fires while empty and recall dies after one prompt. `historyUp`/`historyDown` still own the gating (empty or already-browsing); the view only routes the keystroke.
- **The composer placeholder stays in the view tree, toggled by `.opacity`** — never wrap it in `if draft.isEmpty { … }`. Inserting/removing that sibling on the first recall (empty → text) rebuilds the editor subtree, the `NSTextView` loses first responder, and the *second* ↑ never reaches `keyDown` (recall sticks after one prompt).
- **A server-sent SSE `{type:"error"}` maps to `APIError.agent`, not `.http`.** `codeAssistRoundTrip` retries on the buffered endpoint only for `.http` (transport) failures; an `.agent` error is an explicit, already-redacted application failure and must surface verbatim. Mapping it to `.http` re-ran the same failing call and replaced the real reason with the generic 502 "temporarily unavailable."
- **Flush the active chat session before switching / creating one.** `switchSession` and `createNewSession` call `persistCurrentSession(...)` up front because the `.onChange(of: history)` save is deferred to the next view update — relying on it alone can drop the last reply on a same-runloop navigation away.

### ❌ DO NOT do these

- **Do NOT replace `HistoryTextEditor` with `TextEditor` + `.onKeyPress` for the arrows** — it regresses history recall to a single prompt.
- **Do NOT broaden `codeAssistRoundTrip`'s buffered fallback to also catch `.agent`** — that re-masks real backend errors behind the generic 502.

---

## Tool-call fences must never reach the user (`extension/llm_agent/runtime/{loop,fence}.mjs`)

### ✅ MUST preserve

- **The streaming filter detects `<<<TOOL_CALL>>>` ANYWHERE in the output, not just at position 0.** It originally sniffed the first 15 characters and then forwarded the rest of the call unconditionally, so the commonest shape — a sentence of narration followed by a fence — streamed raw JSON straight into the chat bubble. It also holds back any tail that could still become the marker, so a fence split across deltas (`…<<<TOOL_` + `CALL>>>`) can't slip through in pieces.
- **`stripFenceRemnants` runs on every user-visible reply path** (final answer, deadline reply, iteration-cap reply, pendingTool replies, and both native-loop returns). `parseFence` only removes a *well-formed* fence, so a near-miss spelling or a **ZWJ-redacted** fence is handed to the user as prose. The redacted case is self-sustaining: `redactFence` neutralises sentinels in replayed history, the model imitates the redacted spelling it sees, and the parser can't match it — so it recurs until something strips it.
- **`stripFenceRemnants` only strips a marker when a JSON object follows it.** This repo documents the fence protocol, and the agent must still be able to *explain* it; prose that merely mentions `<<<TOOL_CALL>>>` is preserved.
- **Group the alternation in the loose marker regex** (`(?:END_?TOOL_?CALL|TOOL_?CALL)`). Without `(?:…)` the `|` splits the whole pattern and the match starts at the word instead of the brackets, leaving a stray `<<<` in the reply while still passing a naive "no TOOL_CALL" assertion.
- **Progress events carry a `detail`** (the file / query / command) and the client renders a verb + target ("Reading Foo.swift"), never the tool's wire name. Keep `detail` short — it crosses SSE on every tool call and renders on one line.

### ❌ DO NOT do these

- **Do NOT put tool steps into `CodeAssistTurn`.** `turnActivity` is display-only, like `turnModes`: `CodeAssistTurn` is persisted *and* replayed to the model, which does not need its own tool log fed back to it.
- **Do NOT make `stripFenceRemnants` greedy** (e.g. strip any `<<<`…`>>>` pair). That silently mangles legitimate answers about the protocol and about this repo's own source.

---

## Shell execution (`mac/Sources/LlmIdeMac/Services/BashService.swift`)

### ✅ MUST preserve

- **Drain both pipes CONCURRENTLY with the child, never after it exits.** A pipe holds ~64 KB; a command that writes more blocks in `write()` until someone reads. The original code called `waitUntilExit()` and *then* `readDataToEndOfFile()`, on `@MainActor` — so any repo-wide `grep` deadlocked the whole app, with the pending-action card still on screen and no result ever returned. `BashServiceTests.testLargeOutputDoesNotDeadlock` is that regression; a reintroduction **hangs** the suite rather than failing it.
- **Every run is bounded**: wall-clock timeout, SIGTERM→SIGKILL escalation (the group kill matters — `zsh -c "npm test"` leaves grandchildren holding the write end), and a per-stream output cap. The output becomes a chat history turn, so an uncapped `grep` evicted the rest of the conversation from the model's context.
- **`standardInput = FileHandle.nullDevice`.** Inheriting the app's stdin lets a command that reads input block until the timeout instead of failing fast on EOF.
- **Every non-`Sendable` object (`Process`, `Pipe`, `FileHandle`) is created and consumed inside the background queue**, with only lock-guarded boxes crossing the boundary. That's what lets the cancellation handler and watchdog signal the child safely.
- **`runBashCommand` finishes through `unblockAndFollowUp()`, not `sendFollowup()`.** It runs both from a card tap (`busy == false`) and from `autoChainPendingAction` in Bypass mode (`busy == true`); a plain `sendFollowup()` hits its own `guard !busy` and silently drops the command output, ending the turn with no conclusion.

### ❌ DO NOT do these

- **Do NOT make `execute` `@MainActor` again**, and do not reintroduce a bare `waitUntilExit()` before the reads.
- **Do NOT stop reading a stream once the retention cap is hit** — the loop must keep draining to EOF or the child stays blocked on a full pipe forever.
- **Do NOT let `bash` auto-run outside `editMode == .auto`**, and keep it on the shared `maxAutoGitOpsPerTurn` budget — that ceiling is the only thing bounding a chain of hands-free commands in one turn.

---

## Code Assistant modes (`extension/llm_agent/runtime/route.mjs`, `mode-personas.mjs`, `plan-pipeline.mjs`)

### ✅ MUST preserve

- **The plan-like modes' persona is BINDINGS ONLY; the process is a skill file.** `plan` injects `skills/brainstorming`, `assist_plan` injects `skills/grilling`, and an Execute turn carrying `planExecute` injects `skills/executing-plans` or `skills/subagent-driven-development` — all mirrored VERBATIM from their upstreams (obra/superpowers, mattpocock/skills) into the central kit. `mode-personas.mjs` supplies only what those files cannot know: that the write action is `save-plan` into `llm-doc/plans/`, that there is no git, that facts come from `find-code`/`search-kb`/`project-memory`, and that stage 2 is reached with `load-skill`. The two long hand-written personas this replaced were a paraphrase of `.skills/skills/assist-plan/SKILL.md` that had already drifted from it — re-adding process prose here recreates that drift. `tests/mode-personas.test.mjs` pins the bindings' size and the absence of the old phase list.
- **Every skill id `plan-pipeline.mjs` names must ship in `llm_default_sources/`.** That snapshot is the always-on source every user has; the pipeline resolves ids through the user's ENABLED sources, so a skill missing from it (or dropped from `extension/llm_agent/core-builtin-skills.json`, which the refresh filters the builtin kit by) silently degrades a planning mode to bindings with no process attached — a quiet quality loss with no error anywhere. Pinned by `tests/plan-pipeline.test.mjs`.
- **Exactly ONE pipeline skill is injected per turn.** The four skills total ~58 KB; the stage split (`pipelineSkillIdFor`) is what keeps that affordable. Stage 2 (`writing-plans`) is deliberately PULLED by the model via `load-skill` rather than injected, because nothing the server can see marks the design-approval turn.
- **`load-skill` must stay `kind: 'read'`.** That is what puts it in `allowedToolNames()` for every restricted mode, which is where a skill's "now invoke <other skill>" hand-off matters most — those modes have no shell or filesystem to find it any other way.
- **Plan/Review/Document mode's tool restriction is an explicit tool-*name* allowlist (`mode-personas.mjs`'s `allowedToolNames()`), never `skill.kind`.** `run-bash` and `task-create`/`task-update` are all `kind: read` yet mutate real state (`run-bash` shells out unconfirmed; the task tools write the session's task store) — filtering by `kind` alone would leave them reachable from a "no write tools" mode.
- **`enforceModeToolRestriction`'s post-loop `pendingTool` null-out is NOT redundant with the allowlist above — do not remove it.** `ask-internal`'s nested sub-loop is passed the FULL per-user skill set (`route.mjs` → `ctx.internalSkills.skills = userSkills`), unfiltered by mode, and `loop.mjs` returns a `pendingTool` for a `kind: write` skill before any handler map is consulted. This is the only thing that actually stops a write-tool proposal from surfacing through that one delegation path in a restricted mode.
- **`continueNeeded`/`tasks` in `handleCodeAssist`'s response must stay gated on `!restrictsTools(resolvedMode)`, mirroring the task-list prompt-injection gate.** Session tasks are keyed only by `userId:sessionId`, with no mode dimension, and are never cleared on a mode switch. A restricted mode can never resolve a pending task itself (task-create/task-update are excluded from its allowlist, and its persona forbids acting) — reporting a real `continueNeeded: true` from a stale Execute-mode task left in the same session made the Mac client's auto-continue reflex reschedule forever (no `!busy` guard stops it) and rendered Phase 1's `PlanTimelineCard` on top of a Plan-mode reply.

### ❌ DO NOT do these

- **Do NOT filter a restricted mode's skills map by `skill.kind === 'read'`** — see `run-bash`/task-tools above.
- **Do NOT delete `enforceModeToolRestriction`'s pendingTool null-out as "dead code"** — it is the only guard against the `ask-internal` leak path.
- **Do NOT compute `continueNeeded`/`currentTasks` unconditionally at the end of `handleCodeAssist`** — always gate them on `restrictsTools(resolvedMode)` the same way the prompt injection is gated.
- **Do NOT edit the mirrored skill files in place to fit LLM-IDE** (`brainstorming`, `grilling`, `writing-plans`, `executing-plans`, `subagent-driven-development`). They are verbatim upstream copies so a refresh is a clean re-pull; adapt through the bindings instead.
- **Do NOT re-describe an injected skill's steps in a persona, a tool `.md`, or the Mac's Execute-plan message.** Each restatement is a copy that drifts. `CodeAssistantPanel.executePlanMessage` sends the parsed step list and nothing about method for exactly this reason.

---

## Loop Engineering (`mac/Sources/LlmIdeMac/{Models,Services}/LoopEngine/`)

Design rationale lives in [Loop Engineering](loop-engineering.md); this is the operational checklist.

### ✅ MUST preserve

- **A stage that turns green only after a repair edited a protected path is NOT a pass.** `RepairScopeGuard` detecting the violation is useless on its own — if the loop then re-runs the stage it will observe the exit 0 the violation bought and report `.success`, certifying a regression as fixed. Under `protectedPathPolicy` `.revert`/`.stop` the run MUST terminate as `.blocked(.repairOutOfScope)` and the stage MUST NOT be re-verified. The prompt text asking the agent not to weaken tests is a courtesy, never the enforcement.
- **Protected paths are enforced in code, and `extraProtectedGlobs` is additive only.** The built-in set (tests, build/verify config, `system/`) is what stops the loop certifying a deleted test as a fix. A project may widen it; nothing may narrow it.
- **An unavailable scope check reports `.indeterminate`, never `.clean`.** Reporting "no violations" when the check never ran is precisely the silent pass the guard exists to prevent. The runner then warns and continues (fail-open) — refusing to loop in non-git projects would remove the feature from them entirely, which is worse than the unverified repair every run performed before the guard existed.
- **Journal writes are fail-open and every exit from `LoopEngineRunner.run` goes through `finish`.** A write failure is logged and ignored: telemetry observes the work, it never gates it. And a run rejected at preflight (e.g. `needsApproval`) still writes a record, so "the cron ran and did nothing" stays distinguishable from "the cron never ran".
- **`system/loop-runs/index.jsonl` is append-only.** One line per run, never rewritten, so a crash mid-append costs one unparseable line (skipped on read) instead of the whole history.
- **Every field added to `LoopStage` / `LoopEngineConfig` must be `decodeIfPresent` + default in the hand-written `init(from:)`.** These are persisted as un-migrated UserDefaults JSON on the user's machine. One plain `decode` of a new key makes every existing project's saved config fail to decode, which `LoopEngineConfig.load` reports as "no config" — silently discarding the user's stage list and re-detecting defaults.
- **Config must be rebuilt by copy-and-mutate, never by restating the memberwise initializer.** `LoopStageDetector.ensureDefaultStages` and `LoopEngineView.currentConfig` are the single composition points; an initializer call at a third site silently resets every field it forgets to thread through (and `ensureDefaultStages` runs on all three config-load paths).
- **`ProgressWatch` falls back to hash equality whenever either side has no score.** That fallback IS the pre-scoring behaviour, and it is what guarantees an unrecognised test runner is never made worse by `StageOutputParser` existing. A first failure must report `streak == 1`, so `consecutiveFailureStop == 1` still means "stop on the first failure".
- **`LoopEngineStatus.code` is a stable wire value, independent of `summary`.** It is the grouping key for any analysis over the journal, and it must not vary with the stage name or path list the case carries — otherwise grouping produces one bucket per run. Do not rename a code once it has been written to a journal.
- **`LoopTemplate.applied(to:)` must regenerate every stage id.** Stage ids key `VerifyApprovalStore` approvals; reusing a template's ids would let a shell command approved once in one project run unapproved in every project the template is later applied to.
- **A built-in template must not hardcode a test command.** It carries the `LoopTemplate.detectedTestCommand` sentinel, resolved per project by `LoopStageDetector.detectTestCommand`, and the stage is DROPPED when nothing is detected. A hardcoded `swift test` applied to a Node project fails every iteration for a reason the user did not cause; a stage left carrying the sentinel could never run at all.
- **A `LoopTemplate` carries a whole `LoopEngineConfig`, not a parallel list of fields.** That is what makes a newly added config field automatically part of every template instead of being silently reset on apply.
- **Built-in templates are a static constant and are never persisted.** Persisting them would freeze whatever shipped the first time a user opened the page, so an improved starter could never reach them. `LoopTemplateStore.load` also forces `isBuiltIn = false` on everything it reads, so stored data can never produce an undeletable custom template.
- **The summary-note writer is fail-open, like the journal, and runs after it.** The machine-readable record must exist even when note indexing (more moving parts) fails, and a note that cannot be written never changes a run's verdict.
- **`system/loop.json` is committed; `system/loop-runs/` is gitignored.** The contract has to travel with the repo it verifies (a fresh clone must reload the stage list, not re-detect it); the run log is regenerated per run and would otherwise add a file per run to git history forever. Adding an entry to `ProjectScaffolder.managedGitignoreBlock` also requires adding it to `managedGitignoreUpgrades` — the full block is only written for NEW projects, so the retro-fit list is the only path to existing checkouts.
- **Shell-command approvals stay in UserDefaults, never in the repo.** `VerifyApprovalStore` exists so each machine approves a command before it runs; committed, a cloned repo could ship pre-approved arbitrary shell commands for the cron-triggered loop to execute. This is a security boundary, not a storage preference.
- **`LoopEngineConfigStore` is file-first, and `save` does NOT write back to UserDefaults.** The legacy entry is a read-only migration source, migrated into the file on first load. Keeping both writable would give one config two live copies with no rule for which wins.
- **The UI label is "Loop"; the identifiers are not renamed.** `ShellState.Section.loopEngine.rawValue` is the deep-link payload for `.openSection` and is stored on activity-feed rows, and `AutoTask.loopEngineering.rawValue` keys `taskErrors` plus the persisted Auto Task toggles. Renaming either rawValue orphans links already written to disk. Only `label`/display strings carry the product name.
- **All three fresh-config paths go through `LoopEngineDefaults.newConfig(stages:)`.** The Loop page, the chat command and the Auto Task sweep each detect stages independently; if any builds a `LoopEngineConfig` directly, the app-wide defaults apply on some surfaces and not others depending on where the user first opened the project. Same single-source rule as `LoopEngineConfig.shouldPersist`.
- **`LoopEngineDefaults` stores a stage-LESS config.** Stages are detected per project from its real test tooling, so an app-wide default stage list would override that detection; reusable stage lists are `LoopTemplate`'s job.
- **`LoopEngineConfig` encodes `wallClockBudgetSeconds` as an explicit null, via a hand-written `encode(to:)`.** `nil` means "no time limit" and is now the DEFAULT, so absent and present-null decode identically and the distinction is no longer load-bearing; the explicit encode stays because the stored config should be self-describing, and because any *future* optional field with a non-nil default would need exactly this treatment. That is the lesson to keep: the synthesized encoder omits nil optionals, an omitted key used to mean "written before the field existed ⇒ 3600", and the two collapsed — silently restoring a chosen "no limit" as 60 minutes on the next load.
- **An `.advisory` stage never gates.** It runs and is journalled, but must not trigger repair, count toward a stall, or fail the run — that is the only thing that makes a linter or formatter stage safe to add.

### ❌ DO NOT do these

- **Do NOT re-verify a stage after a protected-path violation** to "see if it really passes" — that reintroduces the reward-hacking path wholesale.
- **Do NOT let a journal write throw or change a run's verdict.**
- **Do NOT attribute an already-dirty file to the repair.** The guard compares only *newly* dirty paths; flagging pre-existing edits would block every run started from a working tree with uncommitted test changes and get the guard switched off.
- **Do NOT make `StageOutputParser` return `0` for unrecognised output.** `nil` and `0` drive different runner paths: `nil` means "fall back to the hash", `0` means "this runner genuinely reports zero failures" (a compile error or crash).
- **Do NOT check the wall-clock budget during the first iteration.** A run always gets one complete pass; checking earlier turns a small budget into a no-op instead of a fast failure.

---

## Auto Task settings + prompt templates (`mac/Sources/LlmIdeMac/{Models,Services,Views}/AutoCode/`)

### ✅ MUST preserve

- **An unconfigured task composes to its own prompt with nothing added.** `AutoTaskPromptComposer.compose` adds a skill directive or a `--- PATHS ---` block only for settings that are actually set, and `AutoCodeUpdateService.composedPrompt` falls back to the task's own prompt when no template is selected. (It does whitespace-trim the body and substitute `{{PROJECT_ROOT}}`, neither of which changes any shipped prompt.) Every task ran an unmodified prompt before this feature existed; anything unconditionally prepended changes the behaviour of every scheduled run for users who never opened the Settings card.
- **A `templateId` that no longer resolves falls back to the own prompt.** A template deleted on disk, or a project closed mid-schedule, must not compose to an empty prompt — a scheduled task would then silently become a no-op the user only discovers in a log.
- **Task settings are scoped BY PROJECT, and so are template drafts.** A config's `templateId` is a filename stem in that project's `templates/auto_task/`, and every project is seeded with the SAME starter slugs (`review-code`, …). A global bucket would resolve `review-code` against whichever project is open — running a prompt written for a different repo, silently. The project-relative input/output paths have the same problem. `AutoTaskConfigStore.bindProject(id:)` and `AutoTaskTemplateStore.bindProject(root:)` are what keep the two in step; `retargetTemplate` is likewise scoped, so renaming one project's template cannot repoint another's tasks.
- **`AppShell.reloadDocTemplatesForActiveProject` is the ONLY caller of either `bindProject`.** Both the config store and the template store are bound there, from the same `.onReceive(.activeProjectChanged)` + `.task(id:)` pair, which is what guarantees they never disagree about which project is open. Nothing in the runner or the mobile bridge binds a scope of its own, so an Auto Task surface hosted outside `AppShell` would silently read the `__no_project__` bucket. Safe today (the scheduler's first tick is a minute after `start()`, called from the same phase), but it is an implicit coupling: a new host must bind, not assume.
- **The unsaved template draft lives in the store, not in the editor's `@State`.** The Auto Task detail pane reuses ONE view tree across tasks, so view state does not survive a sidebar click: a half-written prompt was discarded on task switch, and leaked into the next task's card when both used the same template. A draft belongs to the template and is cleared only by a save or an explicit Revert — including across a rename, which carries it to the new id.
- **`AutoTaskTemplate.normalizedBody` is the one canonical body form, applied by BOTH `render` and `parse`.** Editors must compare against it. Pressing Return at the end of a prompt is an ordinary `TextEditor` habit; with a one-sided trim the save succeeds but the draft stays one newline longer than the stored body, so the card reads "Unsaved" and Save stays lit forever.
- **Input/output paths are validated to be inside the project, in the composer.** `AutoTaskPromptComposer.absolutePath` returns nil for an absolute path, a `~`, or a `..` that escapes the root. The Mac picker cannot produce those, but the paired iPhone can send any string, and a `.implement` task is told to write to whatever comes back — outside the `fix/custom-…` branch nothing is recoverable through git.
- **Renaming a template repoints the configs that referenced it.** The id IS the filename stem, so a rename moves the file and changes the id; `AutoTaskTemplateStore.rename` fires `onTemplateIdChanged`, wired in `LlmIdeMacApp` to `AutoTaskConfigStore.retargetTemplate`. Without that wiring every task using the template silently drops back to its built-in prompt.
- **Seeding happens only when `templates/auto_task/` does not exist.** An empty folder is a user who deleted every prompt; re-seeding on the next project open would resurrect them. This is not the `LoopTemplate` rule above — these seeds are *meant* to be edited, and the un-frozen built-in prompts stay reachable through the picker's "Built-in prompt" row plus Restore Default, so an improved default still reaches everyone.
- **Saving a template body is explicit, not per-keystroke.** The file is shared by every task that selects it; a half-typed prompt must not become what tonight's scheduled runs execute.
- **The skill list comes from the project's `.claude/skills/`, not the server catalog.** An Auto Task runs the AI CLI as a subprocess, so the only skills it can invoke are the ones the CLI discovers on disk. The server's `/kb/agent/catalog` lists the agent loop's own tools, which that subprocess never sees.
- **Paths are stored project-relative and resolved at run time.** A project can move on disk; an absolute path stored in UserDefaults cannot follow it.
- **Every mobile setup mutation replies with a whole fresh `AutoTaskSetupReply`, never an ack.** A rename changes ids and repoints other tasks' configs, so an ack would leave the phone holding state the Mac has already moved past.

### ❌ DO NOT do these

- **Do NOT tell a read-only task to write files.** `compose(writesFiles:)` must match the `persistChanges:` its caller passes to `runCLI`. A review task's tree is reverted afterwards, so a write directive both wastes the run and — for an output path outside the git root, which the clone-into-project layout produces whenever `projectRoot != gitRoot` — leaves files the revert never reaches.
- **Do NOT surface `templates/auto_task/` in the Doc Gen template scan.** `DocTemplateStore.scanProjectTemplates` skips the folder by name; without it, whichever prompt sorts first appears as a bogus document template.
- **Do NOT offer Settings/Template cards on structural tasks.** Regression, Knowledge, Update Plan Status, and the pipeline tasks run no prompt, so every control there would be one that does nothing.

---

## Code Graph layout (`mac/LocalPackages/graph-kit/Sources/GraphCore/Layout/`)

The Graph view showed "sometimes a circle, sometimes a round blob" for a long
time. Three independent causes, each of which is now an invariant.

### ✅ MUST preserve

- **One layout entry point, publishing only a finished result.** `UAGraphView.applyLayout`
  is the single path. The old pipeline published a pie-slice circle immediately
  and cached it through `cacheGraph`, whose `laidOut` flag defaults to `true` —
  so the circle was recorded as a finished layout, and the force-directed result
  that followed was dropped by a node-count guard, a mode switch, or the
  background auto-updater re-storing a raw graph mid-settle. Which one the user
  saw came down to timing.
- **Layout is deterministic.** Same graph in, same picture out — no RNG, no
  wall-clock dependence, sorted iteration. Otherwise the user's mental map of
  their codebase changes on every launch.
- **Layout lives in the `GraphCore` product, never in the `GraphKit` product.**
  Both live in the `graph-kit` folder, but `GraphCore` is always linked while
  `GraphKit` is pluggable. With layout in the engine, uninstalling the
  engine would black out the Graph view instead of merely stopping generation.
- **Anything drawn inside the zoomed `Canvas` is scale-corrected.** Node radius
  was the one thing that was not, while every line width and glow divided by
  `scale`. At a fitted scale of 0.05–0.2 a radius-6 node rendered sub-pixel: the
  graph *was* a fuzzy round cloud of dots. `nodeR` now floors apparent size.

### ❌ DO NOT do these (caused regressions)

- **Do NOT prune edges to make a dense graph legible.** `GraphPrune.capDegree(6)`
  kept edges in *emission order* while both endpoints were under the cap, and
  `StructureGraphBuilder` emits every `contains` edge before the first `imports`
  edge — so any file with more than six symbols spent its whole budget on
  containment and lost all of its dependencies. Measured: **import edges 529 → 94
  on a real repo, 0 of 684 on a synthetic one, graph shattered into 867
  components.** Its doc comment claimed it was "a no-op for the sparse code
  graph"; it was the opposite. Weight edges (`EdgeWeight`) and filter at render.
- **Do NOT emit containment as `relatedTo`.** `MemoryGenerator` (both the Swift
  and TypeScript implementations) emitted `chunk → doc` as `.relatedTo`, which
  made a document's backbone indistinguishable from its title-match noise — so
  any consumer ranking edges by strength left every chunk isolated. It is
  `doc → chunk` with kind `.contains`, parent→child, matching the code track.
- **Do NOT give the force simulation a single global attractor.** A lone
  hardcoded `(600, 400)` pulled every disconnected component into one pile — and
  the pile *is* the round blob. Each node is drawn toward its own community's
  anchor.
- **Do NOT seed a force layout from a symmetric ring.** The pie-slice seed used
  exactly three concentric radii regardless of node count, which both guaranteed
  overlap and left the disc's centre empty; the simulation could not escape it.
  Seed with phyllotaxis around cluster anchors.
- **Do NOT trust `#if canImport(GraphKit)` to gate the compiled-in engine.**
  `canImport` still answers yes for a module left behind in `.build`, so the
  builtin engine compiled in and then failed at *link* time instead of degrading.
  Use the explicit `GRAPHKIT_BUILTIN` define.

### How to verify

`swift test` cannot run in a Command-Line-Tools-only toolchain, so the gate is an
executable:

```bash
cd mac/LocalPackages/graph-kit
swift run -c release graph-layout-lab --compare       # exits non-zero on regression
swift run -c release graph-layout-lab --svg <dir>     # SVG previews for visual check
```

`ring` above 0.20 means concentric rings are back. `overlap` must stay ~0.
Connectivity (`comps`/`largest`) is the *producer's* responsibility, not the
layout's — a real repo graph genuinely arrives fragmented.

---

## Quick reference: where to add X

| I want to… | Touch these files |
|---|---|
| Add a Loop Engineering stage kind | `LoopStage.Kind` + the `switch` in `LoopEngineRunner.run` + a `run<Kind>Stage` helper + `LoopEngineView`'s add-stage menu and `stageDetail` |
| Add a Loop Engineering budget or stop condition | `LoopEngineConfig` (`decodeIfPresent` + default!) + `LoopEngineStatus` (`summary` AND `code`) + the exhaustive `switch` in `AutoCodeUpdateService+PipelineTasks.swift` + `LoopEngineView+DetailPane.swift`'s `settingsSection` + `LoopEngineView.currentConfig`/`loadConfig`/`resetStagesToDefaults` |
| Add a built-in Loop template | `LoopTemplate.builtIns` + a `static let` with a **new stable UUID** (never a fresh one — the picker stores the selection by id) |
| Add something a loop run writes | `LoopRunSummaryWriter.render` + `LoopEngineView+DetailPane.swift`'s `outputSection` (a row with a real path, so it can be revealed) |
| Support a new meeting platform | `extension/src/content/caption-scraper.ts` (add reader), `detectPlatform()` |
| Add a new AI feature | New server endpoint in `extension/server.mjs` + add to `ENDPOINTS` + bump `SERVER_API_VERSION` + add to `REQUIRED_ENDPOINTS` in `extension/src/sidepanel/App.tsx` + new hook under `extension/src/sidepanel/hooks/` (with `language` param + AbortController) + wire into App |
| Add a new UI language | `LANGUAGE_NAMES` in `extension/server.mjs` + `HEADING_LABELS` for questions + LanguageSelector option |
| Change the server port | `extension/src/lib/config.ts` default + `extension/server.mjs` `PORT` + CORS origin list (still `127.0.0.1`) |
| Persist a new piece of UI state | `chrome.storage.local` via the hook that owns it; do NOT add a new store |
| Add a new tab | `TABS` array in `extension/src/sidepanel/App.tsx` + a new panel block + ensure `.tabs` still scrolls at narrow width |
| Persist new meeting data alongside the transcript | Extend `SavedTranscript` in `extension/src/lib/storage.ts`; write in `stopRecording()`; read in `HistoryView` |
| Change how the graph is laid out | `mac/LocalPackages/graph-kit/Sources/GraphCore/Layout/` only — then re-run `graph-layout-lab --compare`. Never touch the renderer to compensate for a layout problem |
| Add a visual encoding to the graph canvas | Add the signal to `GraphLayout` (`GraphLayoutEngine.swift`) so it is computed once, then read it in `CodeGraphCanvas`; do NOT recompute adjacency in the draw loop |
| Swap or remove the graph engine | `extension/graph_generation/README.md`. Unplug = comment the two `// UNPLUG:` lines in `mac/Package.swift` (the `.package` line stays — GraphCore comes from it); add an engine = drop a `graph-engine.json` in a plugin |
