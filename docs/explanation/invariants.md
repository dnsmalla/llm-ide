---
title: Engineering invariants
status: stable
---

# Engineering invariants

> Hard-won fixes and architectural rules that must not regress. Read this before modifying any file listed below. When in doubt, add new behaviour alongside — never delete an invariant here without a migration note in the PR.

## Why this exists

Each invariant maps to a previous regression. The *decision* behind it (why the system is this shape at all) lives as an [ADR](../decisions/). This page is the operational checklist; the ADRs are the rationale.

## Caption scraper (`extension/src/content/caption-scraper.ts`)

### ✅ MUST preserve:

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
- **Prompt-injection-safe text** — `sanitizeLine()` strips control chars + the delimiters `<<<BEGIN>>>` / `<<<END>>>` that server prompts use as fences.

### ❌ MUST filter out (historical bug reports):

| Category | Examples | Filter |
|----------|----------|--------|
| Material icon names | `frame_person`, `visual_effects`, `closed_caption` | `MATERIAL_ICON_PATTERN` + underscored_lowercase check |
| Clock/timestamps | `8:41`, `AM`, `09:15 PM` | `CLOCK_PATTERN`, `CLOCK_ONLY_AMPM` |
| Meeting ID | `ume-xkgs-oqf` | `[a-z]{3}-[a-z]{4}-[a-z]{3}` regex |
| Keyboard shortcuts | `⌘ + d`, `ctrl + h` | `[⌘⌥⇧⌃ctrl]\s*\+\s*[a-z]` regex |
| Meeting info popup | `Dial-in`, `PIN:`, `Your meeting's ready`, `close Close` | `MEET_UI_PATTERNS` + `isMeetUIText()` |
| Phone numbers | `+81 3-4545-0450` | `\+\d{1,3}[\s-]?\d` regex |
| Long digit sequences | `669 889 208 1049` | `\d{6,}` without surrounding text |
| Toolbar buttons | `Turn off microphone`, `Open caption settings`, `Live captions`, `Font size` | `MEET_UI_PATTERNS` |
| Effects panel | `Reframe`, `Backgrounds and effects`, `Portrait`, `Blur` | `MEET_UI_PATTERNS` |

### ❌ DO NOT do these (caused regressions):

- **Do NOT reintroduce `dedupeRepeatedPhrases` or similar text-munging.**
- **Do NOT reintroduce "longest text per tick" or "prefix sentence dropping".**
- **Do NOT restrict scanning to a viewport band** (e.g., `bottom 40%`). Captions move during screen share. Use content filters + generous top-toolbar exclusion.
- **Do NOT rename variables without finding all references.** Historical silent `ReferenceError` from `sentTexts` → `captionBuffers` rename that missed one reference.
- **Do NOT raise minimum caption length above 1.** Short Japanese captions like `はい。` (3 chars) are real.
- **Do NOT tie the scraper to one platform.** Readers dispatch via `detectPlatform()`.
- **Do NOT re-introduce tight coupling to a single `.nMcdL.bj4p3b` selector** — Meet rotates class hashes; we have a cascade of fallbacks.

---

## Speaker detector (`extension/src/content/speaker-detector.ts`)

### ✅ MUST preserve:

- **`cleanup()` resets `lastSpeaker = ''`** — otherwise BFCache restores a stale value and the first post-restore turn gets suppressed.
- Still used by mic mode to enrich utterances with active-speaker metadata.

---

## Message protocol (`extension/src/lib/messages.ts`)

### ✅ MUST preserve:

- **`MsgType` enum covers ALL message types** — `START_CAPTION_SCRAPING`, `STOP_CAPTION_SCRAPING`, `PING`, `CAPTION_FINAL`, `CAPTION_STATUS`, `GET_CAPTION_STATUS`, `CAPTION_SCRAPER_READY`, `ACTIVE_SPEAKER`, `PARTICIPANTS_LIST`, `ERROR`.
- **`Message` union type is strongly typed** — every variant declares its payload fields.
- **`isMessage()` guard validates `type` is a known `MsgType` enum member** — not just any string.
- **Caption messages must include `sessionId`** — the side panel groups updates into one transcript line by sessionId.

### ❌ DO NOT do these:

- **Do NOT use string literals** like `{ type: 'START_CAPTION_SCRAPING' }`. Always use `MsgType.*`.
- **Do NOT accept `message: any` in listeners.** Use `unknown` + `isMessage()` guard so an injected message doesn't crash the app.

---

## Transcript persistence (`extension/src/lib/storage.ts` + useTranscript)

### ✅ MUST preserve:

- **`SavedTranscript` shape includes `segments` (raw), not just the rendered string.** Loading a past session must rebuild the live UI exactly — speaker renames, sessionIds, timestamps — so future LLM calls (Generate Notes, Chat, Questions) work on the real data.
- **`saveTranscript()` is called in `stopRecording()`** — auto-persists when `segments.length > 0`. Reads snapshot values from refs (`segmentsRef`, `speakerNamesRef`, `meetingTitleRef`, `elapsedRef`, `primaryLangRef`) so the callback's deps stay minimal.
- **`MAX_TRANSCRIPTS = 50`** — oldest pruned first to stay under chrome.storage.local's 5 MB quota.
- **`loadTranscript()` refuses while recording** — returns `false`; `HistoryView` surfaces that as a flash message.
- **Storage errors are non-fatal** — `.catch(() => {})` on persist; the live UI is the user's source of truth during a session.
- **Type-only import in storage.ts** — `import type { TranscriptSegment }` avoids a runtime cycle with `useTranscript.ts`.

### ❌ DO NOT do these:

- **Do NOT store only the rendered transcript string.** Loading a session needs segments to rebuild speaker grouping, subtitle export, etc.
- **Do NOT put segments/elapsed/etc. into `stopRecording`'s useCallback deps.** That re-registers the message listener on every caption, leaking handlers.
- **Do NOT raise `MAX_TRANSCRIPTS` without measuring quota usage on long meetings.**

---

## Side panel hook: useTranscript (`extension/src/sidepanel/hooks/useTranscript.ts`)

### ✅ MUST preserve:

- **Session-based segment updates** — when a `CAPTION_FINAL` arrives with the same `sessionId` as the last segment, update in place instead of appending.
- **Speaker name sanitization** — trim, clamp to 50 chars before storing.
- **`MAX_SEGMENTS = 5000` cap** — unbounded growth would crash the panel on multi-hour meetings.
- **Mode ref (`captureModeRef`)** — CC messages only process in `'captions'` mode, mic speech recognition only in `'mic'` mode.
- **`setRecordingSync(bool)` eager sync** — updates both `isRecordingRef.current` and state in the SAME tick. Without this, `captureModeRef` / `isRecordingRef` lag one render and the first caption after Start is dropped.
- **Hybrid mode:** Meet/Teams/Zoom → CC scraper; other pages → Web Speech API on mic.
- **Bilingual mode OPT-IN** (off by default), single language is default.
- **CAPTION_STATUS listener + mount-time `GET_CAPTION_STATUS`** — when the floating popup mounts, it asks the content script whether capture is active and syncs state.
- **`Diagnostics` export** — captionsReceived count + lastCaption timestamp + platform, consumed by Settings tab's Diagnostics grid.

### ❌ DO NOT do these:

- **Do NOT recreate the speech recognition callback chain on every render.** Use refs.
- **Do NOT register `chrome.runtime.onMessage` listeners outside `useEffect` with cleanup.** Memory leaks + double handlers.
- **Do NOT forget the `captureModeRef.current === 'captions'` guard** on `CAPTION_FINAL` — otherwise captions leak into mic-mode transcripts.

---

## Side panel hooks: useNotes / useChat / useQuestions (`extension/src/sidepanel/hooks/*.ts`)

### ✅ MUST preserve:

- **Every LLM hook accepts a `language?: string` parameter** and forwards it in the request body. `App.tsx` threads `transcript.primaryLang` in.
- **AbortController on every request** — cancel-on-unmount via `useEffect` cleanup; cancel-on-clear for `useNotes`.
- **Distinguish timeout (`AbortError` from setTimeout) vs. user-cancel (`AbortError` from cleanup).** Timeout shows "Request timed out"; user-cancel is silent.
- **Strict validation of response shape** — `typeof data?.notes !== 'string' || !data.notes.trim()` → throw. Never render undefined.
- **Stale-server detection in `useQuestions`** — a `404` on `/generate-questions` surfaces: *"The running server is out of date. Restart `node server.mjs` and try again."* rather than a raw upstream error.
- **`useChat` persists messages to `chrome.storage.local`** and restores on mount so side panel ↔ popup share the conversation.
- **Chat history has NO retention cap.** The user owns their conversation; we persist the full array to `chatMessages`. On `QUOTA_BYTES` errors we surface `quotaWarning` through the hook and render a yellow banner in ChatView — we never silently drop old messages.
- **`MAX_HISTORY = 10` is a PROMPT-SIZE bound, not a storage bound.** It caps how many prior messages travel to `/chat` as context. Do not conflate the two.

### ❌ DO NOT do these:

- **Do NOT hardcode `REQUEST_TIMEOUT_MS`.** Import from `extension/src/lib/config.ts`.
- **Do NOT silently swallow the `language` param** in any future LLM hook — add it to the body, or LLM output will regress to English for all non-English users.
- **Do NOT retry on abort** — the user explicitly cancelled.

---

## Side panel App (`extension/src/sidepanel/App.tsx`)

### ✅ MUST preserve:

- **`REQUIRED_ENDPOINTS` array + `serverStale` banner** — `checkServer()` parses the health response's `endpoints` array; if any required endpoint is missing OR the field is absent entirely, show a yellow "restart server" banner.
- **Health check every `TIMING.SERVER_HEALTH_CHECK_INTERVAL_MS`** — user sees server state go offline/online without manual refresh.
- **`HINT_DISMISSED_KEY` first-run hint** — dismissible, remembered in `chrome.storage.local`. Only shown when `!isRecording` and not previously dismissed.
- **`handleStart()` clears notes/chat/questions before starting** — a fresh recording should not show stale AI output from the previous meeting.
- **Pop-out creates a `type: 'popup'` window** of 420×680. User can resize/maximize; CSS adapts. Do not pass fixed `left`/`top`.
- **`language` threaded to every AI consumer** — `notes.generate(..., primaryLang)`, `ExportMenu language={primaryLang}`, `questions.generate(..., primaryLang)`, `chat.sendMessage(..., primaryLang)`.
- **Copy-cmd button** on the offline banner copies `node server.mjs` to clipboard.

### ❌ DO NOT do these:

- **Do NOT hardcode the server URL.** Always `await getServerUrl()`.
- **Do NOT pop out without passing `chrome.runtime.getURL(...)`** — hard-coded URLs break on reload.

---

## Service worker (`extension/src/background/service-worker.ts`)

### ✅ MUST preserve:

- **Auto-inject content scripts on existing tabs** — `chrome.scripting.executeScript` with file paths read from manifest. Handles the case where the extension is loaded AFTER a meeting tab is open.
- **`PING` health check** before injecting — avoid double-injection.
- **Read script paths from `chrome.runtime.getManifest().content_scripts[].js`** — hashed filenames change every build; never hardcode.
- **200 ms delay after injection** before the first `START_CAPTION_SCRAPING` — gives the script time to register its listener.

### ❌ DO NOT do these:

- **Do NOT re-broadcast messages** from the service worker. Content scripts' `sendMessage` reaches the side panel directly. Historical bug: double-sent messages.
- **Do NOT add multiple `onMessage.addListener` calls.** One listener routes all messages; multiples cause `sendResponse` conflicts.

---

## Local server (`extension/server.mjs`)

### ✅ MUST preserve:

- **CORS is a strict allowlist** — `chrome-extension://<id>` + `localhost` / `127.0.0.1`. The `Access-Control-Allow-Origin` header echoes the request's `Origin` (never `*`), and is only set when the origin is in the allowlist.
- **Server binds to `127.0.0.1` by default** — a non-loopback `LLMIDE_HOST` is REFUSED at startup unless `LLMIDE_ALLOW_REMOTE=1` is also set (the operator opting into a TLS-terminating proxy). The server itself terminates no TLS.
- **`runClaude()` prefers the user's stored `claude.apiKey`** (per-user, from the encrypted vault) so multi-user deployments bill each user's own Anthropic account; it falls back to the operator's Claude CLI login (`execFile('claude', ['-p', prompt])`) when no user key is present. A user-scoped key NEVER silently falls back to the operator CLI on failure — that would misattribute spend.
- **2 MB request body limit** — DoS guard.
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

### ❌ DO NOT do these:

- **Do NOT add wildcard `Access-Control-Allow-Origin: *`.** Any site on the user's network could call the local server and steal transcripts.
- **Do NOT accept an API key as a request parameter or store it unencrypted.** A per-user `claude.apiKey` is allowed ONLY via the encrypted vault (`server/vault.mjs`, AES-256-GCM) and is injected into the agent as `ANTHROPIC_API_KEY` per call — never logged, never echoed in errors (it is redacted), never persisted in plaintext.
- **Keep the Claude CLI fallback working.** When a user has no stored key, `runClaude()` must still work via the operator's `claude -p` login. Direct Anthropic HTTP calls are the per-user-key path, not a replacement for CLI auth.
- **Do NOT remove the language directive** from any prompt. Do not assume English.
- **Do NOT drop the prompt-injection fences.** A hostile participant caption otherwise lets the meeting content rewrite the prompt.
- **Do NOT bump `SERVER_API_VERSION` without also updating `REQUIRED_ENDPOINTS` in `App.tsx`** if endpoints changed.

---

## DOCX export (`extension/generate-docx.mjs`)

### ✅ MUST preserve:

- **Japanese font `MS Gothic`** for CJK support.
- **Claude generates structured JSON first**, then the server fills the DOCX template. Do not merge these steps — merging leaks Claude's reasoning into the file.
- **Input caps** — `MAX_CELL_CHARS = 5_000`, `MAX_CELL_LINES = 200`, `MAX_TITLE_CHARS = 200`. Caps are applied via `capText()` / `capLines()` BEFORE fields reach the docx builder so an oversized response can't blow up Word.
- **Array fields (`decisions`, `todos`, `agenda`, `minutes`, `qa`) defaulted to `['']`** when empty — `docx` crashes on empty cell arrays.
- **Language directive in the JSON-generation prompt** so decisions/todos/minutes come back in the meeting's language.

### ❌ DO NOT do these:

- **Do NOT re-import `fs`** — dead import removed; file is streamed in memory.
- **Do NOT bypass `capText` / `capLines`.** Word opens but looks broken if a cell has 50 k chars.

---

## Client library (`extension/src/lib/config.ts`, `extension/src/lib/anthropic.ts`, `extension/src/lib/messages.ts`)

### ✅ MUST preserve:

- **`isSafeServerUrl()` accepts ONLY** `http(s)://localhost`, `http(s)://127.0.0.1`, `http(s)://[::1]` (with optional port). Used by `setServerUrl()` (throws on unsafe) and `getServerUrl()` (silently falls back).
- **`getServerUrl()` strips trailing slashes** — request URLs concatenate `${url}/endpoint`, a trailing slash produces `//endpoint` and a 404.
- **`generateMeetingNotes()` signature**: `(transcript, meetingTitle?, participants?, externalSignal?, language?)` — AbortSignal is threaded through so the UI can cancel.
- **`HEALTH_CHECK_TIMEOUT_MS` is short (few seconds)** and `REQUEST_TIMEOUT_MS` is long — don't unify them.

### ❌ DO NOT do these:

- **Do NOT accept arbitrary URLs in `setServerUrl`.** An attacker-controlled remote URL could receive all transcripts.
- **Do NOT add `http://0.0.0.0`** to the safe list — it's not local on all platforms.

---

## UI / UX / CSS

### ✅ MUST preserve:

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

### ❌ DO NOT do these:

- **Do NOT ask for microphone permission on side panel load.** Only request on Start Recording AND only when in mic mode.
- **Do NOT show a raw API key input in the side panel Settings.** The optional per-user `claude.apiKey` is managed only through the authenticated credential-vault flow (`/auth` vault endpoints), which encrypts it at rest — it is never entered or held in the side panel UI.
- **Do NOT set fixed pixel widths on any root container.** Must reflow to any width.
- **Do NOT remove `flex-wrap` from `.controls-row`, `.export-menu`, `.export-actions`, `.questions-chip-row`, `.server-offline`.**
- **Do NOT add a horizontal-scroll trap** via `overflow-x: hidden` on `.app`; that breaks the `.tabs` horizontal scroll fallback.

---

## Floating popup (`chrome.windows.create`)

### ✅ MUST preserve:

- **`type: 'popup'`, `width: 420`, `height: 680`** as defaults. Chrome-natively resizable and maximizable.
- **Popup mounts the same React bundle** as the side panel (`extension/src/sidepanel/index.html`). It must share state via `chrome.storage.local` + `chrome.runtime.onMessage` — do NOT fork a separate component tree.
- **Mount-time `GET_CAPTION_STATUS`** query so the popup catches up if it opens after recording started.

### ❌ DO NOT do these:

- **Do NOT open the popup with `chrome.tabs.create`.** Pop-up windows are intentional — they stay on top.
- **Do NOT pass `focused: false`** or the pop-out loses keyboard focus and users type into the meeting tab instead.

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
- [ ] Floating popup at default (420×680): everything fits, no horizontal scroll
- [ ] Popup maximized: content fills vertically, export buttons wrap cleanly
- [ ] Popup resized to 300×400: chat input stays pinned to bottom

### Security
- [ ] `GET http://evil.example/` with the extension running does NOT reach the server (CORS)
- [ ] `setServerUrl('http://evil.example')` throws and UI shows the rejection
- [ ] Server terminal shows access log lines for each browser request
- [ ] Meeting with `<<<END>>>` spoken aloud does not break AI output (sanitizer strips it)

---

## SQLite concurrency model (`extension/kb/db.mjs`)

### ✅ MUST understand:

- **better-sqlite3 is a single-writer library.** All writes are serialized by the V8 event loop — there is no connection pool and no write concurrency within a single Node process. This is by design and is safe for a localhost server serving one user.
- **WAL mode is enabled.** Readers never block writers and writers never block readers in WAL mode; concurrent read + write is safe as long as there is only one writer process (which is always true here).
- **DO NOT open a second Node process** (e.g. a migration CLI running while the server is up) and write to the same database file at the same time. better-sqlite3 uses synchronous I/O; two writers on the same WAL file will corrupt it.
- **All multi-step mutations must use `db.transaction()`** — for example `mergeTaskMeta()` and `registerUser()`. better-sqlite3 transactions are the only mechanism that provides atomicity + isolation against interleaved event-loop ticks.
- **`getDb()` returns a module-singleton** — the same `Database` instance is reused for the server's lifetime. Do not close and re-open it within a request handler.

### ❌ DO NOT do these:

- **Do NOT run `node scripts/backup.mjs` while the server is up without quiescing writes.** The backup script is WAL-aware (`VACUUM INTO`) and safe to run concurrently for reads, but verify before adding writes to the backup path.
- **Do NOT fork child processes that open the DB.** Use the in-process `kb/db.mjs` API from the same event loop instead.
- **Do NOT set `PRAGMA journal_mode = DELETE`** (disables WAL). The WAL pragma is applied by the migration runner on first boot and must not be reverted.

---

## GitHub PR / codegen-apply (`extension/agents/github-pr.mjs`)

### ✅ MUST understand:

- **`git push` uses the user's ambient credentials.** The PR flow calls `git push -u origin <branch>` using whatever git config / credential helper the user has set up on their machine (SSH key, HTTPS keychain, etc.). No token is passed to the server; the server never stores one.
- **The working tree must be clean before `openPullRequest()`** — the function now checks `git status --porcelain` and throws if there are uncommitted changes outside `.llmide-auto/`. This prevents codegen-generated files from accidentally staging the user's WIP alongside the auto-generated artifacts.
- **Branch names are prefixed `llmide/auto/<slug>`** — the slug is derived from `taskId` (lowercase alphanumeric + `-_`) so the branch name is deterministic and safe. A branch with the same name existing locally causes an explicit error; the user must delete or rename it before retrying.
- **The function stages ONLY `.llmide-auto/<taskId>/`** — it never stages the rest of the repo.

### ❌ DO NOT do these:

- **Do NOT pass a `ghToken` to `execGit` as an env var or argument.** Token handling is GitHub API only (PR creation); git transport uses the system credential helper.
- **Do NOT call `git stash` inside `openPullRequest()`.** Stashing is destructive and non-obvious to the user. Instead, fail fast with the `status --porcelain` check and let the user resolve it.
- **Do NOT remove the branch-exists guard.** Silently force-pushing would clobber work the user may have done on a branch with the same name.

---

## Quick reference: where to add X

| I want to… | Touch these files |
|---|---|
| Support a new meeting platform | `extension/src/content/caption-scraper.ts` (add reader), `detectPlatform()` |
| Add a new AI feature | New server endpoint in `extension/server.mjs` + add to `ENDPOINTS` + bump `SERVER_API_VERSION` + add to `REQUIRED_ENDPOINTS` in `extension/src/sidepanel/App.tsx` + new hook under `extension/src/sidepanel/hooks/` (with `language` param + AbortController) + wire into App |
| Add a new UI language | `LANGUAGE_NAMES` in `extension/server.mjs` + `HEADING_LABELS` for questions + LanguageSelector option |
| Change the server port | `extension/src/lib/config.ts` default + `extension/server.mjs` `PORT` + CORS origin list (still `127.0.0.1`) |
| Persist a new piece of UI state | `chrome.storage.local` via the hook that owns it; do NOT add a new store |
| Add a new tab | `TABS` array in `extension/src/sidepanel/App.tsx` + a new panel block + ensure `.tabs` still scrolls at narrow width |
| Persist new meeting data alongside the transcript | Extend `SavedTranscript` in `extension/src/lib/storage.ts`; write in `stopRecording()`; read in `HistoryView` |
