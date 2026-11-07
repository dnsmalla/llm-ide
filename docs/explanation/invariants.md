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
- **UI words must not eat real speech.** Every `UI_PATTERNS` alternative ends at a word boundary (an unbounded `^(call|more|…)` dropped the speaker "Callum" and "Moreover, …"). In caption *text*, generic UI words (`UI_PATTERNS`, bare icon words like `chat`/`mic`, `turn on/off`) only reject when the text is label-shaped — ≤ 5 words, no sentence-final punctuation — so "Share your screen, please." survives while "Share screen" does not. Only snake_case icon tokens and the Meet landing banner reject unconditionally.
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
- **Pop-out sends `OPEN_POPUP`**, which the service worker handles by calling `openDesktopDeepLink()`: it opens a tab to `${serverUrl}/launch-app?to=transcript`, which 302s into the `llmide://` scheme so the native Mac app comes to the front. There is no Chrome `type: 'popup'` window.
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

- **CORS is a strict allowlist** — `chrome-extension://<id>` + `localhost` / `127.0.0.1`. The `Access-Control-Allow-Origin` header echoes the request's `Origin` (never `*`), and is only set when the origin is in the allowlist. The allowlist can be extended only by `LLMIDE_CORS_ORIGINS` (exact origins, comma separated; a `*` entry matches nothing). The desktop host sets it, on the core it SPAWNS only (after which the nonce handshake verifies it), to exactly `tauri://localhost,http://tauri.localhost,https://tauri.localhost`; an adopted or externally started core, the Mac app's server and the extension never get it, and `scrub` in `desktop/src-tauri/src/core_env.rs` never copies it from the host environment. Pinned by `extension/tests/server-cors-webview-origins.test.mjs`. Which `chrome-extension://` origins count is set by `<dataDir>/extension-ids.json` (`{"ids": ["<32 chars a-p>"]}`, read once at boot, `extension/core/extension-origins.mjs`): no file means any extension (the old behaviour), a listed set means only those IDs, and a file that cannot be read or parsed means no extension at all (fail closed, never back to any). Pinned by `extension/tests/extension-origins.test.mjs`.
- **Server binds to `127.0.0.1` by default** — a non-loopback `LLMIDE_HOST` is REFUSED at startup unless `LLMIDE_ALLOW_REMOTE=1` is also set (the operator opting into a TLS-terminating proxy). The server itself terminates no TLS. With `LLMIDE_ALLOW_REMOTE=1`, self-registration is also CLOSED unless `LLMIDE_ALLOW_REMOTE_REGISTRATION=1` (every member runs within the grants in `members`; open registration on a reachable server still lets any peer become a member); startup logs `server_remote_registration_open` when both are on.
- **Team authority is enforced in `requireRole`, the turn clamp and the gateway filter; never per route** — `requireRole(db, req, minRole)` (`server/auth.mjs`, ADR 0021) reads the caller's `members` row on every call, so a grant change applies on the next request; the JWT `role` claim is the legacy flag and must never be read again at a route. The 20 admin-gated call sites (`/admin/backup`, `/admin/users`, `/metrics`, the plugin/LLM-source/MCP routes) call it with `'admin'`; a refusal is `403 ROLE_DENIED`. A turn is clamped in ONE place after `mode` is resolved (`runV2Turn`, shared by the HTTP stream and `startHostTurn`): `max_mode` `none` → `403 ROLE_DENIED` (audited `team.deny` with `{ reason }` only), `read_only` → `clampToReadOnly` + `permissionMode` cleared + the chat's Bypass grant revoked, `execute` unchanged. Host API pairing filters served capabilities for a viewer / `max_mode` none member to `host` + `read` + `push` and re-auth applies the same filter to the stored scopes. `usdCapForModel` folds in `members.usd_cap_month` (the smaller of the two non-zero caps). Team assignments come from `<data dir>/team.yaml` (H1.1): `kb/team-yaml.mjs` applies the file exactly ONCE per boot, after migrations and before requests; generation is DEFERRED while the install has no real accounts (an empty file would demote the first registered owner at the next boot), an undefined account is `viewer`/`read_only`/20, a user without a `members` row is created as one, and an invalid file exits the boot (`team_yaml_invalid`) instead of serving stale or wider grants; a file that would leave ZERO owners while real accounts exist also exits (`reason: 'no_owner'`, rolled back) rather than boot a core nobody can administer. Because the file is authoritative, `PATCH /admin/members` and an invited registration WRITE IT THROUGH after their DB transaction (atomic 0600, same generation path, DB wins for a listed account, unknown-email entries and full-line comments preserved); a failed write answers 500 and rolls the grant / registration back so a completed request never leaves DB and file disagreeing (`team.yaml.write`, plus `team.yaml.apply` at boot). Every actual boot change is audited as `team.yaml.apply` with the file actor and from/to only; unknown emails never create users. Pinned by `tests/members.test.mjs`, `tests/auth.test.mjs`, `tests/auth-routes.test.mjs`, `tests/team-routes.test.mjs`, `tests/agent-v2-team-clamp.test.mjs`, `tests/host-api-gateway.test.mjs`, `tests/usage-member-cap.test.mjs`, `tests/invites-registration.test.mjs`, `tests/team-yaml.test.mjs`, `tests/team-yaml-boot.test.mjs`.
- **No agent/tool route bypasses `requireRole` + turn authority (R-014#1)** — `server/route-authority.mjs` is the one deny-by-default table for routes that can run an agent/Loop, edit files, install skills, add a repo or spend model money. `ROUTE_AUTHORITY` declares, per entry, the minimum team role, the highest `max_mode` it needs, and whether it spends under the member's monthly USD cap; `authorizeRoute` reads the `members` row through `requireRole` (never the JWT claim), rejects `max_mode` `none`, refuses a `read_only` member on an `execute` route, and refuses once `usedUsdMonth >= usdCapMonth` (0 = no cap). `server.mjs` enforces it after authentication (after the rate limiter for ordinary routes; auth/extension dispatch before it, so those are checked at their own dispatch point; a disabled feature still answers 404 `feature_disabled`); `POST /kb/loop/agent-run`, `POST /kb/project/install-skills` and `POST|DELETE /auth/me/repos` also call it in the handler, so a direct caller cannot bypass it. A denial is `403 ROLE_DENIED` (role, `max_mode` none/insufficient) or `429 USD_CAP`, and writes exactly one `team.deny` audit row with `{ reason }` only — never a prompt, path, body or model. Current entries include the Loop run and meeting agent (`execute` + cap), every one-shot/pipeline model call (`read_only` + cap: `/kb/complete`, `/kb/agent/ask`, `/generate-notes`, `/generate-questions`, `/extract-entities`, `/generate-doc`, `/kb/generate-plan`, `/kb/analyze-risks`, `/kb/generate-code`, `/kb/providers/turn`, connector classify), file/repo writes (`execute`: install-skills admin-only, `/kb/review/approve`, `/kb/dispatch`, `/kb/docs/*`, `/kb/projects/register`, repo add/remove, `/kb/agent-sdk/update` admin-only, extensions-catalog install/toggle/uninstall/update/rollback/repair/allowlist admin-only). Routes gated elsewhere and deliberately not duplicated: `/agent/v2/stream` (the `runV2Turn` clamp + cap), `/host-api/*` (gateway grant filter), `/admin/*` and the extension admin routes (`requireRole`), `/kb/self-heal/runs` (debug build only, bus host proof + exact repo allow-list), the command bus (tier/client class + host proof). A new route in any of those categories MUST add a `ROUTE_AUTHORITY` row (or document its existing gate here); pinned by `extension/tests/route-authority.test.mjs` (viewer denied, read_only denied, execute allowed, cap exhausted denied, admin-only install-skills, audit rows).
- **`runClaude()` prefers the user's stored `claude.apiKey`** (per-user, from the encrypted vault) so multi-user deployments bill each user's own Anthropic account; it falls back to the operator's Claude CLI login (`execFile('claude', ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '-p', prompt])` — via `spawnCli` / `CLI_ARG_BUILDERS.anthropic` in `providers.mjs`) when no user key is present. `--setting-sources ''` prevents user/project hooks from injecting into the agent context; `--tools ''` makes the invocation a pure completion. A user-scoped key NEVER silently falls back to the operator CLI on failure — that would misattribute spend.
- **A non-Anthropic CLI call with no caller workspace runs isolated** — `runViaCli` (`providers/providers.mjs`) given no `cwd` roots `codex`/`gemini` in a fresh empty private (0700) temp dir that it removes afterwards (success or failure), never the server's cwd (which holds `kb/` — the DB and dev secrets) — the prompt may carry untrusted email/connector text and these CLIs are agents. Codex stays `-s read-only` (plus `--skip-git-repo-check`, since the temp dir is not a repo); `--yolo` / `--dangerously-*` are never passed; env is `minimalCliEnv` (HOME for the CLI's login, no server secrets). A caller-supplied `cwd` (Code Assistant turn with a project root) is used exactly as given. The routed model rides the argv as `-m` only when `cliModelId` accepts it (no leading `-`, strict charset), and usage is metered under that id — or `cli-default` when the flag was omitted, never a model the CLI was not told to run.
- **Keyless codex/gemini routes never serve untrusted-input roles** — `providers/tier-routing.mjs` `resolveFeatureRoute` returns null (reason `cli_untrusted_input`) when the tier would run the OpenAI/Google agent CLI (no API key) and the feature is `internal` (email/connector/transcript text), `pipeline` (output dispatched to issue trackers) or `decisions` (the `decide` tool's `state` is ticket text / test output): codex's read-only sandbox can still read absolute paths. Such a tier is also usable only after its CLI passes a cached `--version` probe (`providers/route-health.mjs`; never awaited on a model-call path), and a routed call that fails for a non-content reason is retried ONCE on the caller's default (`routeFallback`) with the route marked failed for (provider, model) — ~10 min when broken, ~60 s when transient. Content failures (400/413/422 on the prompt), aborts and hang-breaker kills are never retried; a usage pause on the routed provider falls back without being remembered. Every runClaude wrapper (e.g. /code-assist's `makeCodeAssistRunClaude`) MUST forward `routeFallback`, and the SSE `error` event keeps `code: PROVIDER_UNAVAILABLE` only before any tool step or streamed text (status-only thinking/writing lines don't count; a later retry would replay side effects). A revoked key (401/403 on the native loop before a tool step) and a missing/disabled/keyless custom provider are tagged PROVIDER_UNAVAILABLE in `llm_agent/runtime/route.mjs` too.
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
- **Bypass needs the host's proof when the host started the core** — with `LLMIDE_HOST_APPROVAL_KEY` set, `POST /agent/v2/stream` `permissionMode: "bypass"` without a valid, single-use, CHAT-BOUND (v2, purpose `bypass:<chatId>`) `x-llmide-host-approval` token is `403 HOST_APPROVAL_REQUIRED`, and phone/extension/remote origins and any request lacking `x-llmide-client: desktop-ui` plus the bus host proof are capped at Ask (`core/host-approval.mjs`, `tests/host-approval-bypass.test.mjs`). A valid token opens a 30-minute per-user per-chat grant; switching the chat to another mode ends it. Unset, the legacy behaviour is byte-identical. Never log the key or a token. A new file that names the bypass mode is a new entry point and must go through the same gate.
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
- **`generateMeetingNotesStream()` signature**: `(transcript, onChunk, meetingTitle?, participants?, externalSignal?, language?)` — AbortSignal is threaded through so the UI can cancel.
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

- **`OPEN_POPUP` handler in service-worker.ts** calls `openDesktopDeepLink()` — do not remove or bypass it.
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
- **Do NOT write a migration that rebuilds a large table or index.** Migrations run synchronously on the server's first `getDb()` (the `/health` request), and the Mac app kills a server that has not answered `/health` within 20 s (`BackendManager.waitForReadyThenRun`) — then restarts it mid-migration, which rolls back and repeats. Rebuilding the trigram `search` index took 10–20 s on a real database. Swap triggers and add side tables instead, and let later writes migrate rows lazily (0037 is the pattern).
- **Do NOT rebuild `search` without carrying `search_source_rowid` along.** The `sources` triggers find their FTS row through that map (0037); a copy-and-recreate like 0033 renumbers the rows, so a mapped rowid would then point at some OTHER row — a source update would silently delete an unrelated meeting's or plan's FTS row and leave its own stale copy behind. Either copy `rowid` explicitly or `DELETE FROM search_source_rowid` in the same migration (the legacy `*_legacy` triggers then handle every source the slow way, once).
- **Do NOT gate a slow trigger statement with a WHERE term.** Measured: `NOT EXISTS (…)` as a WHERE term inside a trigger body still scans the FTS table on every row; only a trigger's own `WHEN` clause skips the body.

---

### agent.db (`extension/kb/agent-db.mjs`, `extension/kb/agent-store.mjs`)

- **MUST understand:** agent-run history lives in a separate SQLite file, `agent.db`, beside the main DB: in `LLMIDE_DATA_DIR` when that is set (the Mac app sets it), or beside an explicit `LLMIDE_DB_PATH` (`LLMIDE_AGENT_DB_PATH` overrides it). It is in the same process, so the single-writer rule above still applies.
- **MUST preserve:** every write to `agent.db` is best-effort. Enqueueing never throws and never blocks a model turn; a failed batch is dropped and counted in `store_meta.dropped_rows`. A corrupt file is quarantined under a unique `agent.db.corrupt-<ts>[-n]` name and recreated; a boot never fails because of it.
- **MUST preserve:** live state (sessions, memory, permissions, approvals, personas, feedback, `model_limits`, `quota_state`, `usage_ledger`) stays in the main DB. Cleaning never touches it. Tests use a temp `agent.db` derived from the test DB path, never `kb/agent.db`.
- **DO NOT** store prompts, responses, tool arguments or error messages in `agent.db`. Codes, counts, sizes and ids only.
- **MUST preserve (rollup vs open runs):** the rollup never folds a run still `running`, nor that run's tool events and composition rows; they stay raw and fold after the run closes. Run recording (chat, Loop, meeting, auto-task, dispatch, review) is best-effort and never changes a run's result.
- **MUST preserve (shadow metrics):** the `shadow` block of `GET /kb/storage` carries counts only (state, windows, pairs, scored queries, mean overlap, timestamps). No query text, sample rows, provider or model names.
- **MUST preserve (usage shadow):** `usage_ledger` in the main DB is authoritative. `agent.db` `usage_calls` is a shadow only: it mirrors each ledger row after the boot step has set its id floor, and no budget or limit read uses it yet. Budget reads must fail closed to the ledger whenever `agent.db` is down, quarantined or mismatched (a lost shadow row would otherwise loosen a cap). `Clear` never deletes `usage_calls`.

## GitHub PR / codegen-apply (`extension/agents/github-pr.mjs`)

### Data move: repo kb → data dir (`extension/kb/data-dir-migration.mjs`)

- **MUST preserve:** every move runs under the `.migrating-lock` directory in the data dir. Nothing is wiped while another live pid holds it, and the `data.db` check is repeated under the lock. A dead pid's lock is stale.
- **MUST preserve:** the legacy DB is held with an EXCLUSIVE lock for the whole move. If that lock cannot be taken, nothing moves. An idle server connection counts.
- **MUST preserve:** nothing is deleted before the committed copy is fsynced and verified again (integrity_check, counts, `sqlite_sequence`, secrets bytes, agent-sdk manifest). Originals become `<name>.pre-move`, kept for one boot, and are deleted only by a later boot that opened the DB healthily.
- **DO NOT** remove a `data.db` from the retry path, and treat a zero-byte or table-less `data.db` with no marker as not migrated (move it aside as `data.db.empty-<stamp>`).
- **DO NOT** start the repo-kb layout on a moved kb (`MOVED-TO-APP-SUPPORT.txt` present, `kb/data.db` absent): the tripwire refuses unless `LLMIDE_ALLOW_EMPTY_LEGACY=1`.
- **DO NOT** resolve dev secrets (or create any file) in the repo kb on a moved kb: `core/config.mjs` applies the tripwire before `loadDevSecrets`, and test runs use ephemeral in-memory secrets.
- **DO NOT** prune backups outside the data dir's `backups/`, and never in the repo-kb layout (`config.backupPrune`).
- **Known limit:** Node has no `F_FULLFSYNC`; on macOS the fsync is a plain fsync, so the `.pre-move` copies are the protection against power loss.

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

## Tool permissions — "always allow" rules (`extension/kb/tool-permissions.mjs`, `llm_agent/sdk/engine.mjs` canUseTool, `llm_agent/tools/registry.mjs` run-bash)

### ✅ MUST preserve

- **The safety gate runs FIRST, a rule only skips the prompt tier.** `blocked` and write containment are decided before any rule, session grant or mode is consulted — in every mode, `bypass` included.
- **Rules are per user × project × tool, and shell rules are command PREFIXES** (`npm test`, `git status`), matched at a word boundary. A compound command (`;`, `&&`, `|`, redirects, `$(…)`, backticks, `${…}`, newlines) never matches a rule and is never offered one.
- **Every mode honours saved rules.** `manual` (the pre-v55 spelling of `ask`) used to ignore them — which is why "Always Allow" was saved and then never took effect.
- **"Allow all edits in this chat" is in memory only** (per user + chat session), never persisted.
- **The sandbox's network ask (`SandboxNetworkAccess {host, port}`) is a real approval, and its rules are per HOST.** An org's managed Claude Code settings can force the sandbox on (`settingSources: []` does not drop the policy tier); a command reaching a non-allow-listed host then calls `canUseTool` with this pseudo-tool. It used to hit the unknown-tool deny — npm got a 403 "(user denied)" and plan execution stopped with the user never asked. Bypass or a saved host rule allows, restricted modes deny, anything else shows the card. Whether the sandbox is on is stated by `LLMIDE_V2_SANDBOX` (`inherit` default = pass no `options.sandbox`, so managed settings decide as before; `off` / `on` pass an explicit value, `on` keeping `bashNeedsPerCallApproval` authoritative).

### ❌ DO NOT do these

- **Do NOT reintroduce a tool-wide grant for shell tools** — one "Always Allow Bash" letting every command in every repo run unasked is the defect the prefix rules replaced.
- **Do NOT offer or honour a tool-wide `SandboxNetworkAccess` rule** — it would open every host to every sandboxed command.
- **Do NOT honour the pre-0034 `tool_approvals` rows** — they are global and listed only so they can be removed.

## Desktop Loop shell execution (`desktop/src-tauri/src/{loop_runner,loop_approval}.rs`)

### ✅ MUST preserve

- **A Loop shell command runs only after a NATIVE host approval pinned to its exact SHA-256 (R-014#2).** `system/loop.json` is a working-tree file the webview can write; a `window.confirm()` or a localStorage "approved" list is not a boundary. The host derives the stage list and every fault `verify:` command itself, shows the exact commands and the canonical working folder in a Cancel-first native dialog (`confirm::ask`), and mints an in-memory token bound to the command hashes, loop/stage (or fault path) and folder. `loop_run_stage`, `loop_run_loop` and `loop_run_fault_verify` refuse before spawning when the token is missing, expired, scoped elsewhere, or the command changed.
- **Editing a command AFTER approval invalidates the approval.** Approval is checked against the CURRENT bytes the host re-reads; a changed hash returns `the command changed since it was approved; nothing ran`. There is no fallback that runs the unapproved command.
- **`system/loop.json` is untrusted input, not a command source the page can bypass.** The webview supplies only a loop/stage id or a project-relative fault path. `run_loop_gated` authorises every shell stage BEFORE the first process starts, so a changed later stage refuses the whole pass instead of running the earlier ones.
- **A scheduled run never prompts and never self-approves.** It reuses a still-valid grant for the exact same command set (`loop_approval_status`) or skips the loop. The grant expires (`GRANT_TTL_MS`, 4 h) and `loop_revoke_approvals` clears every grant.
- **Non-shell stages stay functional.** `regressionSweep` (the deterministic no-op/refusal slice), `skill`, `testMap`, `artifactCheck`, `codeGraph` and `testPrune` do not require a shell approval; only commands the host will execute do.

### ❌ DO NOT do these

- **Do NOT reintroduce a page-side confirmation as the gate** (`window.confirm`, a localStorage approval, a query param). The native dialog is the human click; the token it mints is the proof.
- **Do NOT accept a command string from the webview** or expose `run_command_at`/`run_command_cancellable` as a Loop entry point. `run_command_cancellable` is Self-Heal's fixed-script helper only.
- **Do NOT approve a command the host did not read and display**, and do not truncate the approved command set in the dialog. If it is too large to show, refuse rather than approve unseen commands.
- **Do NOT blanket-approve every shell command in every project.** A grant is scoped to the shown hashes, loop/stage, canonical folder and expiry; a changed command or another loop/folder is refused.

## Agent-engine prompt cache + metering (`extension/llm_agent/sdk/{engine,turn-context}.mjs`, `routes/agent-v2.mjs`)

### ✅ MUST preserve

- **The system prompt is stable for a chat's mode.** The cache is a prefix cache in the order tools → system → messages, and a v2 chat resumes one SDK session, so a change anywhere in the system prompt invalidates the whole cached transcript behind it. Only language, system context (without recent issues/meetings), personas, guidance and the pipeline skill live there.
- **Per-turn context rides in the user message, fenced as `<<<LLMIDE_CONTEXT>>>`**: invoked skills, recent issues/meetings, session-memory facts, the task list, attachments. Each is sent only when the SDK session has not seen it (`turn-context.mjs`); the record is written only after the model received the turn, and forgotten on a compaction.
- **Session memory is for a session WITHOUT a transcript.** It is injected only when `turn-context.mjs` has no record for the SDK session (new chat, unresumable, server restart, after a compaction), chosen by recency plus relevance (`session-memory-select.mjs`). A resumed session already holds the turns the facts came from.
- **Session facts are revisable.** The extractor is shown the chat's newest session facts (`MAX_SESSION_LISTED`); a changed decision reuses its key (`[state|session-<key>]`, upserted in place) and a no-longer-true one is listed in `session_superseded`, validated against what was shown. The `session-` prefix keeps session keys from overwriting project facts copied into the same table.
- **Token totals come from `result.modelUsage`.** Streamed, each content block is its own `assistant` message carrying the same usage snapshot; summing them counted cache reads ~3× over and output only partially (a real turn: 126 metered vs 21,029 actual output tokens). One ledger row per model; non-main models are `/agent/v2/stream:internal`.
- **`result.modelUsage` is a RUNNING total per SDK session (SDK ≥ 0.3.277)** — a resumed session's first result already carries earlier turns. A turn meters the difference from its session's baseline (`usage-baseline.mjs`); a resumed turn with no baseline (server restarted) falls back to streamed usage, one entry per API response. Never meter `modelUsage` or `total_cost_usd` as-is on a resumed turn.
- **The `claude -p` fallback asks for `--output-format json`** so its calls (mode classifier, memory extraction, nested hops) are metered with tokens, not as bare runs.

- **The mode classifier sees at most ~2k chars** (head + tail, fence-neutralised — `clipForClassifier`), and an auto-continue round (`AUTO_CONTINUE_MESSAGE` + pending tasks) skips it and runs execute, in both engines.
- **v2 does not mount `ask-internal`** — its nested loop only had `search-kb` + project memory, which a v2 turn has itself; mounted descriptions naming it are rewritten (`v2Description`).
- **Reasoning effort follows the mode, never the model** (`effortForTurn`): `high` for plan/assist_plan/execute, `medium` otherwise and for bare greetings (not acknowledgements — "ok" can mean "go ahead"); none on a gateway turn.
- **`project_memory` results are tool-sized** (`PROJECT_MEMORY_TOOL_CHARS`, 10k) and a `{ text }`-only tool result goes out as plain text — it stays in the transcript for the rest of the chat.
- **v2 gets a project-memory SUMMARY in the turn's context block, not in the system prompt** (`PROJECT_MEMORY_SUMMARY_CHARS`, 2.5k): rendered `stableOnly` (repo.md, the environment note and the graph overview only — no chat facts, which are written after most turns, and no `(updated N min ago)` age, which ticks every minute) so it only changes when one of those files does, sent once per SDK session and again only when its hash changes (`memoryHash`), and skipped when no memory file made it in (the "nothing generated yet" placeholder). The model never called `project_memory` on its own, so without this the curated facts and the environment note never reached v2.

### ❌ DO NOT do these

- **Do NOT append anything that changes between turns to `systemPrompt.append`** — not session memory, tasks, issues, attachments or timestamps. Put it in the turn's context block.
- **Do NOT re-send an already-delivered attachment or fact in the message** — unlike the system prompt, the message stays in the transcript, so repeats stack up (auto-continue re-sends attachments up to 8 times).

## Code Assistant modes (`extension/llm_agent/modes/mode-personas.mjs`, `plan-pipeline.mjs`; the classic `route.mjs` was deleted in API 92)

### ✅ MUST preserve

- **The plan-like modes' persona is BINDINGS ONLY; the process is a skill file.** `plan` injects `skills/brainstorming`, `assist_plan` injects `skills/grilling`, and an Execute turn carrying `planExecute` injects `skills/executing-plans` or `skills/subagent-driven-development` — all mirrored VERBATIM from their upstreams (obra/superpowers, mattpocock/skills) into the central kit. `mode-personas.mjs` supplies only what those files cannot know: that the write action is `save-plan` into `llm-doc/plans/`, that there is no git, that facts come from `find-code`/`search-kb`/`project-memory`, and that stage 2 is reached with `load-skill`. The two long hand-written personas this replaced were a paraphrase of `.skills/skills/assist-plan/SKILL.md` that had already drifted from it — re-adding process prose here recreates that drift. `tests/mode-personas.test.mjs` pins the bindings' size and the absence of the old phase list.
- **`.skills` is the ONLY skill source — there is no fallback copy.** `default_sources`/`llm_default_sources/` (a committed, curated snapshot copied from enabled sources) was removed: `llm-sources/registry.mjs`'s `BUILTIN_ID` (`.skills`) is now the sole seeded, non-removable source, read in place, unfiltered — no `core-builtin-skills.json` allowlist any more. A brand-new user (no persisted enable state) implicitly has `BUILTIN_ID` enabled (`llm-sources/state.mjs`'s `listEnabled()` fallback) so a fresh install isn't skill-less. A registry / state file persisted *before* v44 still names `default-sources`: `seedBuiltinOnce()` drops that registry entry and `state.mjs`'s `migrateLegacyDefaultSources()` maps it onto `BUILTIN_ID` in every affected user's enabled set (`seedBuiltinOnce()` calls it itself, *before* dropping the registry row so a concurrent `pruneOrphans()` can't strip the id unmapped — which covers every seed site: boot, `GET /auth/me/llm-sources`, and the skill-library builder) — without that, such a user's only enabled source points at a deleted directory and they silently have no skills at all (the `listEnabled()` fallback doesn't apply because they *do* have an entry). Consequence: if `.skills` isn't initialized (`git submodule update --init .skills` never ran, or the checkout predates it), **every skill is unavailable**, including the planning pipeline's hardcoded ids (`plan-pipeline.mjs`'s `DISCOVER_SKILL_IDS`/`WRITE_SKILL_ID`/`EXECUTE_SKILL_IDS`) — Plan/Assist Plan/Execute modes lose their process entirely, not just one skill. This is surfaced LOUDLY, not silently: `server.mjs` logs `skills_repo_missing` at boot when `resolveCentralSkillsRepo()` resolves to nothing, and `GET /health`'s `checks.skills`/`checks.skillsError` reflect the same check on every call. `scripts/install-skills.sh` and `setup.sh` already treat a missing `.skills` submodule as a hard, fatal setup error (`set -e`) — the boot/health check exists for the separate case of starting the server directly without having run setup first. Pinned by `tests/plan-pipeline.test.mjs` (skipped, not failed, when `.skills` isn't checked out locally — see its own note on why).
- **LLM-source item selection stores the UNCHECKED set, and every writer keeps it.** `llm-sources/state.mjs` user entries are `{ enabled, disabledItems: { [sourceId]: ["<kind>:<name>"] } }` (kinds `skill|agent|command|template`; hooks/MCP stay whole-source). Absent = checked, so an item an update adds is on and an uncheck survives updates. `setEnabled`, `setItemsEnabled`, `migrateLegacyDefaultSources`, `pruneOrphans` and `pruneMissingItems` all spread the existing entry — rewriting it as `{ enabled }` silently re-checks everything. Every consumer filters: `listSkillLibrary` (chat "/", phone, Loop), `listGenerationLibrary` (Doc Gen/Visual), and `POST /kb/project/install-skills`, which passes the user's unchecked Central Skills skills/commands/agents to the kit's `install.sh --exclude` as kind-qualified `skill:`/`command:`/`agent:` entries (a skill and a command can share a name — `app-forge` — and a bare name would drop both) so they leave the project's `.claude/skills` etc. too; keys the installer can't name are dropped, not fatal. Display names are stored as-is (any non-empty, control-free name ≤ 120 chars), so a third-party "Code Reviewer" still gets a working checkbox. Library commands/agents are the kit's `commands/` + `agents/` families; the project's `config/tool/<tool>/{commands,agents}` files that aren't also in those families aren't listed and can't be unchecked. Pinned by `tests/llm-sources-state.test.mjs`, `tests/llm-sources-items.test.mjs`, the kit's `test-install.sh` (cases 7–9).
- **An LLM-source Update never discards local work.** `updateSource` refuses (409) on uncommitted changes; Central Skills only fast-forwards (`fetch origin main` + `merge --ff-only`, refusing a clone with local-only commits); a managed git clone moves with `reset --hard FETCH_HEAD` (the old shallow `fetch` + `checkout <ref>` left it on its previous commit). When the kit is this checkout's `.skills` submodule, the update re-runs `scripts/sync-skills.sh` (`.skills-lock` + synced tool defs). `checkSourceUpdate` never throws — failures are `status: 'unknown'`; checks run in parallel, and even `?force=1` reuses a result younger than a minute. Sync-script failures come back in `warnings`, never in `corrected`. Pinned by `tests/llm-sources-update.test.mjs` (real git against a local bare repo).
- **The server may GET fixed package-registry hosts only for MCP version checks.** `mcp/registry-versions.mjs` fetches npm dist-tags (`registry.npmjs.org`) and PyPI JSON (`pypi.org`) with a package name validated by `mcp/package-spec.mjs` BEFORE it is placed in the URL, `redirect: 'error'`, a 5 s timeout, a 1 h cache for successes and 5 min for errors. MCP version checks and the Agent SDK updater (`llm_agent/sdk/updater.mjs`) are the only exceptions to "the server fetches no URLs" (a rule that exists against SSRF on plugin installs): the host is never derived from input, so there is no SSRF surface. Update/pin/re-sync of an MCP server revokes consent and enable for EVERY user for that id.
- **Issue writes to GitHub/GitLab go only through `routes/issue-writes.mjs`, to fixed hosts, for the board's own issues.** `POST /kb/issues/{create,comment,close}` need the bus host proof, read the token from the vault only, call `api.github.com` or `gitlab.com/api/v4` (never a host or base URL from the request), and write only to an issue or repo already on the caller's board whose stored URL is on `github.com` / `gitlab.com` (`kb.findTicket`). A self-hosted GitLab token must never be sent to gitlab.com. A value over a limit is refused, never cut short. Audit rows never hold the text or token. No other operation (edit, reopen, labels, PRs, a passthrough path) is added without a plan. Pinned by `extension/tests/issue-writes.test.mjs`.
- **A plan-like turn first decides whether there is anything to execute** (`plan-pipeline.mjs` `TRIAGE_CLAUSE`). A question, an investigation whose output is findings, or a change already in place is answered, opening with **Nothing to execute.** — and the Mac never offers Save/Execute on a reply that opens with that line (`PlanEditPolicy.looksLikePlan`, pinned in `chat-contract-lab`). Any change, however small, still gets a plan. On the Execute side, a step with nothing to do is `skipped`, never `failed`: `failed` ends the run as "Plan execution stopped". Before this, every request was planned and the no-op plans failed at Execute.
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

## Code Graph layout (`graph-kit/Sources/GraphCore/Layout/`)

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
cd graph-kit
swift run -c release graph-layout-lab --compare       # exits non-zero on regression
swift run -c release graph-layout-lab --svg <dir>     # SVG previews for visual check
```

`ring` above 0.20 means concentric rings are back. `overlap` must stay ~0.
Connectivity (`comps`/`largest`) is the *producer's* responsibility, not the
layout's — a real repo graph genuinely arrives fragmented.

---

## Host API v1 transport security (`extension/server/host-api-listener.mjs`, `extension/routes/host-api/`)

Test names `HostApiV1*Tests` below were the retired Swift app's; the Node and SharedProtocol tests remain.

1. **The v1 listener binds a non-loopback interface only in TLS mode.** Plaintext stays on loopback behind the dev flag, and a plaintext upgrade to the TLS port is refused. Tests: `HostApiV1TLSListenerTests` ("the dev plaintext listener still binds loopback only", "plaintext to the TLS port is refused"), `host-api-tls.test.mjs` ("TLS binds every interface; plaintext binds loopback").
2. **An identity read failure never regenerates the identity** (a new certificate would silently unpin every phone). A desktop vault change resets the identity and wipes v1 devices. Tests: `HostApiV1IdentityTests` ("load-or-create persists one identity; reset makes a new one; a read failure never regenerates"), `host-api-identity.test.mjs` ("load-or-create persists one identity, encrypted; a vault change resets and wipes v1 devices", "an unexpected error propagates and leaves identity and devices intact").
3. **The fingerprint is `sha256:` plus base64url(SHA-256(SPKI))**, pinned by `schema/host-api/v1/fixtures/security/identity-vector.json`. Tests: `host-api-security-fixtures.test.mjs` ("vector fingerprint is sha256: + base64url(SHA-256(SPKI DER))"), `HostApiV1IdentityTests` ("the fingerprint matches the shared Node/openssl vector").
4. **The `Origin` rule is exact and shared**, with no wildcard (`fixtures/security/origins.json`); https origins are honoured only in TLS mode. Tests: `host-api-origins.test.mjs`, `HostApiV1OriginsTests`, `host-api-tls.test.mjs` ("the web Origin allowlist: a listed https origin upgrades, another is 403 origin_refused").
5. **Effective capabilities are served ∩ granted, and a legacy token never gets `tool_approvals`.** Widening needs a re-pair. Tests: `host-api-scopes.test.mjs` and `HostApiV1ScopesTests` ("a legacy token (no stored scopes) gets host, chat and approvals, never tool_approvals").
6. **Audit rows and logs never hold a PIN, a token, key bytes or frame content.** Detail and peer are clamped to 200 characters. Tests: `host-api-audit-rate.test.mjs` ("audit rows: pair_failed, pair_ok, token_failed, revoke_self, scope_denied…"), `HostApiV1AuditRateTests` (`auditRows`, `file`).
7. **A phone pin is set or replaced only by a QR scan** (QR-only pinning: a typed PIN works only for a desktop this phone already pinned from a QR, and keeps that pin). A `wss` endpoint needs a pin before any socket opens; `ws` is allowed only to loopback. A `pin_mismatch` is a hard refusal and never clears credentials. Covered by `HostApiPinningTests` ("pinning is QR-only", "wss needs a pin before any socket opens", "a pin mismatch is a hard refusal"; `make test-shared-protocol`) and the device rows in `docs/mobile/verification.md`.

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
| Change how the graph is laid out | `graph-kit/Sources/GraphCore/Layout/` only — then re-run `graph-layout-lab --compare`. Never touch the renderer to compensate for a layout problem |

## Derived note index (`extension/kb/note-index.mjs`, migration 0050)

### ✅ MUST preserve

- Note FTS rows carry `kind = 'note'` and `meeting_id = char(1) || 'note:' || id`. Client meeting ids may not contain control characters or that prefix (`checkMeetingId`), so a meeting delete can never remove a note's FTS row.
- Every query that does not ask for `kind 'note'` excludes it (`search()` adds `kind <> 'note'`).
- A migration that rebuilds the `search` table MUST call `rebuildNoteIndexSearch(db)` afterwards. The `note_index_search` map stores rowids, which a rebuild renumbers; `indexStatus()` reports `consistent: false` until the map is rebuilt.
- A hidden note is removed from the index, not only skipped (upsert deletes the existing row).

### ❌ DO NOT do these

- Do not rely on the map's rowids after any change to `search`; rebuild from `note_index` instead.
- Do not add a per-note kind other than `note` to `search` without updating the `kind <> 'note'` guard.

### Live-then-archive Phase 2 (the Mac feed, `lta.mode`)

The client side below was the retired Swift app's feed; the server-side refusals (409 codes, `allowEmpty`) still hold for any client.

- The Mac feeds the index only when `lta.mode` is `shadow` or `on` (default `off`, read at environment start). Nothing is written to the index or to agent.db's compare keys while it is off.
- **Prune only what a complete scan proves absent, per key.** A pass prunes a row only when the scan read the whole folder and no chunk or entry is missing. A key the Mac cannot index (unparseable frontmatter, an iCloud or Dropbox placeholder, a note too large to upload, an oversize body) is sent as `keep` and is never pruned; the other rows the folder no longer names are pruned. The Library shows one count line for the kept keys.
- **An empty folder is a special case.** An empty manifest prunes only when two complete empty passes, at least one reconcile interval apart, see the same volume that last held notes (`allowEmpty` is then sent). The server refuses an empty prune without `allowEmpty` (409 `EMPTY_MANIFEST_REFUSED`, or `EMPTY_SCAN_REFUSED` for a chunked scan). A missing or unmounted folder is a scan failure, never an empty scan.
- **Chunked scans.** Each chunk carries its entries; the final chunk (`complete: true`) declares `totalEntries` and may carry `keep` and `allowEmpty`. The server compares the received entry count with `totalEntries` (409 `SCAN_TOTAL_MISMATCH`) and prunes nothing when a chunk never arrived (409 `SCAN_INCOMPLETE`). A new scan for a project abandons its unfinished scans. An older server (no chunk route) never gets a prune.
- **Placeholders and links.** An iCloud placeholder (`.name.md.icloud`) is recognised by name and maps to `name.md`; it is never read. A file is also treated as a placeholder when its download status says so, or when it reports a size but no allocated blocks. A symlink to a folder is skipped; a dangling link is skipped.
- **Flaps are counted, not prevented.** The index is not scoped by device. A pruned note that the folder names again within an hour (for example, another Mac on the same account) is counted as a flap and shown in the pass stats. Device scoping is not implemented.
- **The feed is bound to one account.** It stops on project close, on quit and on sign-out (`NoteIndexHost` is `SessionScoped`), restarts on the next sign-in for the same project, and every request re-checks the signed-in user, so a switch sends nothing under the new token.
- **The shadow compare fails when it compared nothing.** `ok` is true only for state `ok`. A non-empty index with zero scored queries is `not-evaluated`; a project with no complete pass in seven days is `stale`. Staleness comes from the last complete pass (`note_index_pass`), not from row changes. A project whose orphan notes (no legacy meeting) exceed 2 % fails the run. The compare scores only meetings that have a note in the index, and it never stores or logs query text.
- **A failed compare retries.** A slice that throws, or a run with per-pair errors, writes no day key; the next tick retries with backoff (1 minute, doubling to 1 hour).

**To clear the index** (after `lta.mode` is turned off, or to reset a project): the index is derived, so deleting it loses nothing. Call `POST /kb/index/reconcile` with the project's id, `"manifest": []`, `"prune": true` and `"allowEmpty": true` as the signed-in user; every row of that project is removed. Without `allowEmpty` the server refuses the request. Re-enabling the mode rebuilds it from the Mac files.

### ❌ DO NOT do these (Phase 2)

- Do not prune a key the scan did not prove absent: a kept key, a key from a pass with a dropped or unreadable item, or a key from a scan that is not the complete final chunk.
- Do not send an empty prune without `allowEmpty`, and do not treat a missing folder as an empty folder.
- Do not send a feed under an account other than the one it started for.
- Do not add a query that has no FTS term to the compare: it would scan the whole `search` table.

### Live-then-archive Phase 4 (chat quit archive, `lta.mode`)

The client side below was the retired Swift app's; the server-side purge rules still hold.

#### ✅ MUST preserve

- **`lta.mode = off` is today's behaviour**: no async quit hook, `deleteSession` keeps its best-effort server calls, sign-out wipes ordinary chats. The one exception is a chat that exists nowhere else (`origin == "extension"` or an archive digest): it is never wiped, in any mode.
- **Never delete before verify.** A Mac chat's working state is purged only after the file is verified and a receipt recorded; an extension chat's rows are deleted only against the hash the Mac recomputed from the file it wrote, after the file was flushed to disk.
- **The server refuses to purge under a turn.** `POST /agent/v2/sessions/purge`, the tombstone routes and `purgeChat` skip a chat with a turn in flight (`busy`) or a receipt older than the chat's last use (`staleReceipt`); the client treats both as retry later.
- **An orphan is purged by the working-state route only**, 7 days after the Mac first saw it missing, never when the store directory is unresolved or empty or the server chat list was not read completely, and never if the chat still has server rows.
- **A quit reply is always sent** after the async hooks (the 6 s cap); anything cut is finished by the next start's sweep (retried with backoff). The backend is killed at `willTerminate`, after the reply.
- **The user's delete intent is written (`pending-deletes.json`, with the user and the time) before the file is removed**, kept until the server says `done`, and sent only by that user.
- **Ownership is never claimed silently.** New files are stamped at creation; older chats stay visible until the explicit "Claim" action, which patches the raw JSON (one key, every other byte preserved). Another user's file is not loadable and cannot be overwritten.
- **Sign-out never wipes in `shadow` or `on`.**

#### ❌ DO NOT

- Call `ChatSessionStore.delete` for cleanup the user did not ask for (use `deleteQuietly`); it records a tombstone.
- Put a non-chat JSON file in `sessions/` (every `*.json` there is read as a chat).
- Treat a failed or partial server chat list as complete (a chat with rows would look like an orphan).
- Round-trip a chat file through the model just to add a tag (it drops what this build cannot read).

## Desktop capture archivist (`desktop/src-tauri/src/capture_archivist.rs`)

The host adopts finished extension captures from the core it spawned (`GET /kb/live/unacked`, `GET /kb/live/:id/capture`), writes each one as a meeting note and acks `POST /kb/live/:id/ack`.

### ✅ MUST preserve

- **Ack only a note that read back.** The ack is sent only after `capture_store::finalize` (create without overwrite, read back, frontmatter id and transcript line count verified) or `find_archived` (the same bytes already on disk) returned a note, and only when the held rows equal the `lines` the ack echoes. Tests: `capture_archivist::tests` (`a_failed_write_is_never_acked…`, `rows_that_do_not_match…`).
- **Idempotent by content.** A crash between the write and the ack is repaired by the next pass finding the same note under the same name family (`final_rel` plus `-2` to `-9`), so no second note is written. Test: `a_crash_between_write_and_ack_never_makes_a_second_note`.
- **Credentials only to the verified spawned core,** through the session `ChatService::bind` verified. Every bind and unbind moves the generation, and before each capture of a pass `Slot::still_serves` re-resolves the verified core: a changed generation, a core that is no longer verified (crashed, or a squatter on its port) or a core now on another port ends the pass, so the token never reaches a new owner of `:3456`. Tests: `the_slot_binds_rebinds_and_forgets`, `a_pass_stops_when_the_verified_core_moves_or_goes`.
- **Bounded:** 5 captures per 20 s pass, 3 attempts per capture per launch, 16 MB per capture response.
- **No capture text in any log** (`desktop/scripts/check-capture-privacy.test.mjs` covers every `capture_*.rs`).
- **The spawned core runs with `LLMIDE_LIVE_ACK=1`** (`core_host::SPAWNED_CORE_FLAGS`), and it is never taken from the host env.
- **The desktop core is spawned on `:3456` when that port is free** (`core_host::SPAWN_PORTS` = 3456, then 3457-3459), because the Chrome extension talks only to `:3456`. A server already answering there is probed first: never adopted in a release build, never launched over or sent a credential (`note_foreign`), and the spawn moves to the next port with `extensionReachable: false`. `extensionReachable` is true only when the bound port equals the live port. A supervised restart waits up to 3 s (`RESTART_PORT_WAIT`) for the port its own just-exited core held before skipping it. Before every spawn the host pins the core's CORS to the extension ID (`core_env::pin_extension_ids`, `extension-ids.json`). Tests: `a_nonce_less_listener_on_the_live_port_is_never_used_and_the_core_spawns_on_the_next`, `a_free_live_port_gets_our_core_and_the_extension_can_reach_it`, `a_supervised_restart_waits_for_the_live_port_instead_of_moving_off_it`, `the_extension_pin_names_only_our_extension_and_is_private`, `extension/tests/extension-origins-core.test.mjs`.

### ❌ DO NOT

- Ack before a verified note exists, or ack with values other than the server's own `lines` and `hash`.
- Let the core write the notes folder: the notes root is the host's (`notes_fs.rs`, chosen by a native dialog and re-validated per call).
- Summarise an archived capture in the background: meeting text goes to a model only from Library's Re-summarise.
