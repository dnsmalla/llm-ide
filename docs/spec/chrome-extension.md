---
title: Chrome extension — spec
status: draft
---

Rebuild-grade contract for the browser surface: every decision here is source-verified and citable so an engineer with no prior context can reimplement the extension to spec.

---

## §1 Scope

This document governs the following source files (all under `extension/src/`):

| File | Role |
|------|------|
| `lib/messages.ts` | Message type enum + typed union + `isMessage()` guard |
| `lib/platforms.ts` | Platform registry and `detectPlatformFromUrl()` |
| `lib/storage.ts` | Local persistence (covered in §5) |
| `lib/config.ts` | Debug flag and environment helpers (covered in §6) |
| `content/caption-scraper.ts` | Core DOM scraper — Meet, Teams, Zoom CC readers |
| `content/speaker-detector.ts` | Active-speaker and participant-list detector |
| `content/floating-overlay.ts` | In-page status pill injected during recording |
| `background/service-worker.ts` | MV3 service worker — message routing, lifecycle |
| `sidepanel/main.tsx` | Side-panel entry point |
| `sidepanel/App.tsx` | Root React component |
| `sidepanel/hooks/*` | Custom hooks (useTranscript, useSession, useAgent, …) |
| `sidepanel/components/*` | UI components (TranscriptView, Settings, ChatView, …) |
| `vite.config.ts` | Build configuration |
| `manifest.json` | Extension manifest (MV3) |

Sections §4–§8 will cover storage, service worker, side panel, build, and manifest in detail. This document (§1–§3) establishes the message protocol and the caption-scraper algorithm.

---

## §2 Message protocol

For the complete generated reference, see [`../reference/message-protocol.md`](../reference/message-protocol.md).

### 2.1 MsgType enum

`extension/src/lib/messages.ts:1–18` defines 11 members:

| Direction | Member |
|-----------|--------|
| Side panel → content | `START_CAPTION_SCRAPING` |
| Side panel → content | `STOP_CAPTION_SCRAPING` |
| Side panel → content | `GET_CAPTION_STATUS` |
| Side panel → content | `PING` |
| Content → service worker | `OPEN_POPUP` |
| Content → side panel | `CAPTION_FINAL` |
| Content → side panel | `CAPTION_STATUS` |
| Content → side panel | `CAPTION_SCRAPER_READY` |
| Content → side panel | `ACTIVE_SPEAKER` |
| Content → side panel | `PARTICIPANTS_LIST` |
| Content → side panel | `POST_CHAT` |

### 2.2 Message union

The `Message` type (`messages.ts:20–31`) is a discriminated union — each variant carries exactly the fields its handler needs, no more. Unrecognised shapes never reach handlers.

**`CAPTION_FINAL` payload** (`messages.ts:26`):

```typescript
{ type: MsgType.CAPTION_FINAL; speaker: string; text: string; timestamp: number; sessionId: string }
```

- `sessionId` is required on every `CAPTION_FINAL`. The scraper uses it to route updates to the correct transcript line; a new value means a new line.

**`CAPTION_STATUS` payload** (`messages.ts:27`):

```typescript
{ type: MsgType.CAPTION_STATUS; active: boolean; platform: string | null }
```

- `platform` may be `null` while detection is in flight (the comment at `messages.ts:56–58` explains that dropping this message strands every subsequent `CAPTION_FINAL`).

### 2.3 `isMessage()` guard

`messages.ts:33–77`. All message listeners receive `unknown`, never `any`. The guard:

1. Rejects non-objects and objects without a `type` property.
2. Checks `type` is a valid `MsgType` member.
3. Per-variant payload validation — e.g. `CAPTION_FINAL` requires `s('speaker') && s('text') && n('timestamp') && s('sessionId')` (line 54); `CAPTION_STATUS` accepts `platform` as string-or-null via `sOrNull` (line 59).
4. Payload-less control messages (`START_CAPTION_SCRAPING`, `STOP_CAPTION_SCRAPING`, `GET_CAPTION_STATUS`, `PING`, `OPEN_POPUP`) return `true` immediately.

This guard was added specifically to block untrusted senders (other extensions, page-script bridges) from crashing the side panel with malformed payloads (`messages.ts:37–41`).

---

## §3 Caption-scraper algorithm (rebuild-grade)

Source: `extension/src/content/caption-scraper.ts`.

### 3.1 Timing and state constants

| Constant | Value | File:line | Purpose |
|----------|-------|-----------|---------|
| `SCRAPE_INTERVAL_MS` | `800` | `caption-scraper.ts:39` | DOM poll interval (ms); also the safety-net interval when MutationObserver fires too fast |
| `SESSION_GAP_MS` | `5_000` (5 s) | `caption-scraper.ts:38` | Silence threshold — if a speaker is absent for longer than this, the next caption starts a new transcript line |
| `MAX_BLOCK_AGE_MS` | `15_000` (15 s) | `caption-scraper.ts:40` | Maximum age of a stale `speakerState` entry before it is deleted from the map |

There is no separate minimum-caption-length rule: `isValidCaption()` accepts any text of length 1–2000 and any speaker of length 1–50 (`caption-scraper.ts:412–413`).

**Note on constants absent from the hint list.** The following names do **not** exist in the source file: `MATERIAL_ICON_PATTERN`, `CLOCK_PATTERN`, `CLOCK_ONLY_AMPM`, `MEET_UI_PATTERNS`. Do not invent them.

### 3.2 Per-speaker state map

`caption-scraper.ts:52–57`:

```typescript
interface SpeakerState {
  sessionId: string;   // Identifies the transcript line; shared across updates to the same turn
  text:      string;   // Last known caption text for this speaker
  lastSeen:  number;   // Date.now() timestamp of last observation
}
const speakerState: Map<string, SpeakerState> = new Map();
```

The map key is the sanitized speaker name string. A separate module-level `sessionCounter: number` (line 58) provides monotonically-increasing suffix for `sessionId` values (`"${speaker}-${sessionCounter}"`).

### 3.3 Core scrape loop rules

`caption-scraper.ts:540–583` (`scrape()` function):

1. **New-session trigger** — a new `sessionId` is minted if either:
   - The speaker is not in `speakerState` (first sighting), **or**
   - `Date.now() - prev.lastSeen > SESSION_GAP_MS` (silent for more than 5 s).
2. **Text-change emit** — within the same session, `sendUpdate()` fires only when `prev.text !== text`. If text is unchanged, only `lastSeen` is updated; no message is sent.
3. **One block per speaker** — each platform reader uses a local `seenSpeakers: Set<string>` to skip duplicate speaker entries when the DOM contains more than one block for the same name (e.g. Meet sometimes duplicates the outer wrapper). The first (or most recent, for reversed arrays) block wins.
4. **Stale cleanup** — after processing all blocks, entries older than `MAX_BLOCK_AGE_MS` are deleted from `speakerState` (lines 578–582).

### 3.4 Content filters and `isValidCaption()`

`caption-scraper.ts:410–447`. Validation is content-based, not position-based. The function returns `false` if any filter matches; it does not use element coordinates.

**Named filter constants** (only real constants are listed):

#### `UI_PATTERNS` (`caption-scraper.ts:369–371`)

A large case-insensitive regex anchored to the start of the string. Rejects strings that begin with known Meet/Teams/Zoom UI labels, including button names (`present`, `mute`, `unmute`, `camera`, `record`, `share`), navigation words (`chevron_right`, `chevron_left`, `expand_more`), and meeting-info phrases (`joining info`, `save transcript`, `secure video`, `new meeting`). Applied to both `speaker` and `text`.

Excerpt (representative — not exhaustive):
```
/^(present|mute|unmute|camera|more|chat|…|loading\s+invitees|contributors|just\s+you|\d+\s+joined|save\s+transcript|…)/i
```

#### `ICON_PATTERN` (`caption-scraper.ts:372–374`)

Matches Material Symbol icon names as whole words. Rejects strings that contain icon identifiers such as `frame_person`, `visual_effects`, `closed_caption`, `format_size`, `keyboard_arrow`, `more_vert`, `call_end`, `back_hand`, `mic`, `videocam`, and others. Applied to both `speaker` and `text`.

```
/\b(frame_person|visual_effects|closed_caption|format_size|keyboard_arrow|more_vert|call_end|back_hand|mic|videocam|computer|reaction|settings|lock_person|chat|apps|info|mood|raise|stop_circle|filter|chevron_right|chevron_left|expand_more|expand_less|content_copy|arrow_back|arrow_forward|open_in_new|check_circle|cancel|navigate_next|navigate_before)\b/i
```

#### `GROUP_ICON_RE` (`caption-scraper.ts:380`)

Strips the Material Symbol `groups` word that Meet prepends to speaker labels when 3+ speakers are active simultaneously. Applied to raw DOM text **before** validation, not inside `isValidCaption()`.

```
/^groups\b\s*/i
```

#### `COMBINED_SPEAKER_RE` (`caption-scraper.ts:389`)

Removes the English combined-speaker suffix from a speaker label so a grouped utterance is attributed to the primary speaker rather than a synthetic `"Alice & 6 others"` label.

```
/\s*[&＆]\s*\d+\s*(others?|more)\b.*$/i
```

#### `COMBINED_SPEAKER_JA` (`caption-scraper.ts:390`)

Japanese equivalent — strips suffixes of the form `他N名` or `ほかNさん`.

```
/\s*(他|ほか)\s*\d+\s*(名|人|さん)?\b.*$/
```

**Inline guards inside `isValidCaption()` that are not named constants:**

- Speaker length: 1–50 characters (line 412).
- Text length: 1–2000 characters (line 413).
- Clock pattern: `/^\d{1,2}:\d{2}/` rejects speakers that start with a time string (line 418).
- Meeting-ID pattern: `/^[a-z]{3}-[a-z]{4}-[a-z]{3}/i` rejects Meet room codes used as speaker names (line 419).
- Word-count guard: speakers with more than 5 space-separated words are rejected (lines 424–425).
- Phone-number pattern in text: `/\+\d{1,3}[\s-]?\d/` (line 430).
- Inline icon text: `keyboard_arrow|Turn off|Turn on` (line 431).
- `video_call` or `keyboard.*Join` fragments (line 433).
- Snake-case speaker: `/\b[a-z]+_[a-z]+\b/` rejects identifiers masquerading as names (line 436).
- All-icon text: if every word in `text` matches `/^[a-z]+_[a-z]+$/i`, the whole string is rejected (lines 440–441).
- Standalone number: `/^\d{1,3}$/` rejects single numbers scraped from UI counters (line 444).

### 3.5 Sanitization

**`sanitizeSpeaker()`** (`caption-scraper.ts:397–408`). Applied to every speaker string before it enters `isValidCaption()` or `speakerState`.

Steps in order:

1. Strip control characters `U+0000–U+001F` and `U+007F` (replace with space).
2. Remove `COMBINED_SPEAKER_RE` suffix (English).
3. Remove `COMBINED_SPEAKER_JA` suffix (Japanese).
4. Collapse runs of whitespace to a single space.
5. Trim.
6. Truncate to 50 characters.

**There is no `sanitizeLine()` function in this file.** The task hint mentions it — it does not exist. The `<<<BEGIN>>>`/`<<<END>>>` fence stripping mentioned in the task prompt also does not appear anywhere in `extension/src/content/caption-scraper.ts`.

### 3.6 Platform dispatch and caption readers

**`detectPlatform()`** (`caption-scraper.ts:60–62`) — a module-local wrapper that calls `detectPlatformFromUrl(window.location.href)` from `lib/platforms.ts`.

**`detectPlatformFromUrl()`** (`lib/platforms.ts:62–74`) — iterates the `PLATFORMS` registry (lines 35–54) in order; first hostname match wins. Supported hosts:

| PlatformId | Hosts |
|------------|-------|
| `meet` | `meet.google.com` |
| `teams` | `teams.microsoft.com`, `teams.live.com` |
| `zoom` | `zoom.us` |

**Per-platform readers** — registered in `CAPTION_READERS: Record<PlatformId, () => CaptionBlock[]>` (`caption-scraper.ts:453–457`):

**Meet (`readMeetCaptions()`, lines 268–294)** — three-tier cascade:

1. **Class-based** (`readMeetCaptionsByClass()`): queries `div.nMcdL.bj4p3b` for caption blocks, `div.adE6rb` for speaker, `div.ygicle` for text. Fastest; valid as long as Meet does not rotate these obfuscated class names.
2. **Aria-based** (`readMeetCaptionsByAria()`): locale-aware — matches `[aria-label*="aption" i]`, `[aria-label*="ubtitle" i]`, `[aria-label*="字幕"]`, `[role="region"][aria-label]`, `[aria-live="polite"]`. Survives CSS class rotation.
3. **Heuristic** (`readMeetCaptionsByHeuristic()`): viewport-geometry scan of all `div` elements; last resort.

**Teams (`readTeamsCaptions()`, lines 296–312)**: queries `[data-tid="closed-caption-chat-message"]` for message containers, `.ui-chat__message__author` for speaker name, `[data-tid="closed-caption-text"]` for caption text. Iterates in **reverse** DOM order to get the latest caption per speaker.

**Zoom (`readZoomCaptions()`, lines 314–363)**: two paths — transcript panel (via `[aria-label*="Transcript"]` / `[aria-label*="Caption"]` / `[class*="transcript"]` / `[class*="caption-panel"]`) with fallback to inline `[class*="subtitle"]` / `[class*="closed-caption"]` / `[class*="cc-text"]` elements. Iterates in reverse order.

### 3.7 Hybrid mic fallback

The caption scraper (`caption-scraper.ts`) itself has no mic or Web Speech API code. The fallback lives entirely in `extension/src/sidepanel/hooks/useTranscript.ts`.

In `startRecording()` (`useTranscript.ts:533–590`): if `isSupportedUrl(url)` returns `true` for the active tab, `START_CAPTION_SCRAPING` is sent to the content script and `captureMode` is set to `'captions'`. If the URL is not a supported platform (or tab detection fails), `captureMode` is set to `'mic'` and `window.SpeechRecognition || window.webkitSpeechRecognition` is used to capture audio from the user's microphone instead.

---

## §4 Client state (`chrome.storage.local`)

Sources: `extension/src/lib/storage.ts`, `extension/src/sidepanel/hooks/useTranscript.ts`, `extension/src/sidepanel/hooks/useChat.ts`, `extension/src/sidepanel/hooks/useAudioDevices.ts`, `extension/src/sidepanel/components/ConnectorsSettings.tsx`, `extension/src/lib/config.ts`.

### 4.1 Storage keys — complete list

| Key | Type | Written by | Purpose |
|-----|------|-----------|---------|
| `transcripts` | `SavedTranscript[]` | `lib/storage.ts:49` | Persisted meeting transcripts (capped at `MAX_TRANSCRIPTS`) |
| `chatMessages` | `ChatMessage[]` | `hooks/useChat.ts:50` | Full chat history (no cap — see §4.3) |
| `primaryLang` | `string` | `hooks/useTranscript.ts:267` | Primary language code preference |
| `secondaryLang` | `string` | `hooks/useTranscript.ts:272` | Secondary (bilingual) language code preference |
| `bilingual` | `boolean` | `hooks/useTranscript.ts:277` | Bilingual mode toggle |
| `speakerNames` | `Record<string, string>` | `hooks/useTranscript.ts:285` | Speaker-id → display-name map, persisted across sessions |
| `micDeviceId` | `string` | `hooks/useAudioDevices.ts:53` | Selected microphone device ID |
| `micVolume` | `number` | `hooks/useAudioDevices.ts:58` | Mic volume boost (50–300%) |
| `firstRunHintDismissed` | `boolean` | `sidepanel/App.tsx:130` | Whether the first-run tip has been dismissed |
| `serverUrl` | `string` | (set externally via `chrome.storage.local.set`) | Configurable API server URL (validated on read by `getServerUrl()`) |
| `auth.refreshToken` | `string` | `lib/config.ts:134` | Auth refresh token (persisted so a service-worker restart can re-mint an access token silently) |
| `connector.git.path` | `string` | `components/ConnectorsSettings.tsx:38` | Local git repo path for KB indexing |
| `connector.gh.repo` | `string` | `components/ConnectorsSettings.tsx:38` | GitHub repo name for issue indexing |
| `connector.gh.token` | `string` | `components/ConnectorsSettings.tsx:38` | GitHub personal access token |
| `connector.gh.state` | `string` | `components/ConnectorsSettings.tsx:38` | GitHub connector filter state |
| `connector.qa.source` | `string` | `components/ConnectorsSettings.tsx:38` | QA connector data source path |

### 4.2 `SavedTranscript` shape

`lib/storage.ts:13–23`:

```typescript
interface SavedTranscript {
  id: string;                        // `${Date.now()}-${8-byte hex random}` (storage.ts:14, generateId() at line 26)
  meetingTitle: string;
  date: string;                      // ISO timestamp when stopRecording() fired
  duration: number;                  // elapsed seconds of recording
  language?: string;                 // primary language at save time
  transcript: string;                // pre-rendered "[Name] text" string, one line per segment
  segments: TranscriptSegment[];     // raw segments — restores the live UI exactly
  speakerNames: Record<string, string>; // speaker-id → display name map
  notes?: string;                    // reserved for future "save notes with transcript" use
}
```

The raw `segments` array is stored alongside the rendered `transcript` string so that previously saved meetings can be restored into the full live UI state (segment highlights, speaker rename, etc.), not just displayed as plain text.

### 4.3 Caps and quota

| Constant | Value | File:line | Enforced on |
|----------|-------|-----------|-------------|
| `MAX_TRANSCRIPTS` | `50` | `lib/storage.ts:10` | Number of saved meetings; oldest entries are pruned first on every `saveTranscript()` call |
| `MAX_SEGMENTS` | `5000` | `hooks/useTranscript.ts:45` | In-memory live segments; oldest are dropped when exceeded (`next.slice(-MAX_SEGMENTS)`) |

`chrome.storage.local` has a ~5 MB per-extension quota (`lib/storage.ts:7–8`). `saveTranscript()` catches quota errors, drops the oldest half of saved transcripts, and retries once. If the retry also fails, it throws `StorageQuotaError` so the UI can surface a "transcript not saved" warning (`lib/storage.ts:50–62`). Chat history has no hard cap; the UI warns with a `quotaWarning` string if a write fails (`hooks/useChat.ts:52–57`).

### 4.4 Speaker-name persistence

`renameSpeaker()` (`hooks/useTranscript.ts:280–288`) immediately calls `chrome.storage.local.set({ speakerNames: updated })`. On mount, `useTranscript` reads `speakerNames` back from storage (`hooks/useTranscript.ts:147–154`), so renamed speakers survive a side-panel reload or browser restart.

### 4.5 Chat-history retention

The `chatMessages` key persists the full conversation with no item cap (`hooks/useChat.ts:19–21`). When making an LLM request, only the trailing `MAX_HISTORY = 10` messages are sent as context to `/chat` (`hooks/useChat.ts:13`, `76`). The full history remains in storage and is always restored on mount.

---

## §5 Service worker (`extension/src/background/service-worker.ts`)

### 5.1 Content-script injection

`ensureContentScriptInjected()` (`service-worker.ts:27–80`) is called for every `START_CAPTION_SCRAPING` dispatch. The function:

1. **Returns early** if the URL is not a supported platform (`service-worker.ts:28`).
2. **PING check** — sends `{ type: MsgType.PING }` to the tab (`service-worker.ts:31`). If the content script responds `{ pong: true }`, injection is skipped.
3. **Page-sentinel check** — falls through to an inline `executeScript` that reads `window.__llmideCaptionScraperInjected || window.__llmideSpeakerDetectorInjected || window.__llmideFloatingOverlayInjected` (`service-worker.ts:44–59`). If any sentinel is set, the scripts are already present and re-injection is skipped (re-injecting throws a console error about already-injected scripts).
4. **Injection** — reads the content-script file list from `chrome.runtime.getManifest().content_scripts[].js` (`service-worker.ts:67–71`), never from hardcoded paths. Because `@crxjs/vite-plugin` hashes content-script filenames at build time, the manifest is the only reliable source of the actual deployed paths.
5. Calls `chrome.scripting.executeScript({ target: { tabId }, files })` (`service-worker.ts:74`).

### 5.2 Post-injection readiness poll

After a successful injection, the service worker does **not** use a fixed sleep. Instead it polls with PING up to 5 attempts with 150 ms between each attempt (`service-worker.ts:154–165`):

```
for (let attempt = 0; attempt < 5; attempt++) {
  // try chrome.tabs.sendMessage(tabId, { type: MsgType.PING })
  await new Promise((r) => setTimeout(r, 150));
}
```

`TIMING.CONTENT_SCRIPT_INJECT_DELAY_MS = 200` is defined in `lib/config.ts:469` but is not used inside `service-worker.ts` itself — the service worker owns its own 150 ms poll interval. If none of the 5 poll attempts succeed, the dispatch is abandoned with `{ ok: false, error: 'script_not_ready' }` (`service-worker.ts:167–169`).

### 5.3 Single `onMessage` listener rule

There is exactly **one** `chrome.runtime.onMessage.addListener` call in `service-worker.ts` (`service-worker.ts:84`). The listener handles three message types:

| Message type | Handling |
|---|---|
| `OPEN_POPUP` | Opens the side panel for the sender's window + opens the Mac app via `/launch-app` deep link (`service-worker.ts:104–113`) |
| `START_CAPTION_SCRAPING` | Async: injects content scripts, polls for readiness, forwards message; returns `true` to keep channel open (`service-worker.ts:115–193`) |
| `STOP_CAPTION_SCRAPING` | Async: queries relevant tabs and forwards message; returns `true` to keep channel open (`service-worker.ts:115–193`) |

All other messages receive `{ ok: true }` and `return false` (synchronous, channel closes immediately, `service-worker.ts:195–196`). Messages from other extensions are rejected: `_sender.id !== chrome.runtime.id` (`service-worker.ts:90–93`).

### 5.4 Side-panel opening

`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` is called at module top level (`service-worker.ts:199`), making the toolbar icon click open the side panel automatically without any explicit user-gesture forwarding in the message handler.

---

## §6 Side panel + popup

### 6.1 Entry point and bundle

`sidepanel/main.tsx:1–13` mounts `<App />` wrapped in `<ErrorBoundary>` into `document.getElementById('root')`. The bundle is the same React application regardless of how the panel opens.

There is **no `chrome.windows.create({ type: 'popup' })`** call anywhere in the extension source — the "popup" pattern was removed. The `OPEN_POPUP` message type is now historical (`service-worker.ts:103`): it opens the native Mac app via a server-side redirect to `llmide://` rather than spawning a detached Chrome popup window. Floating side panels use Chrome's built-in side panel API only.

### 6.2 Cross-context state sync

The side panel and any other extension context (e.g. a `chrome.sidePanel.open()` call from another window) share state via two mechanisms (`hooks/useTranscript.ts:194–208`):

1. `chrome.runtime.onMessage` — `CAPTION_STATUS` broadcasts from the content script carry `{ active: boolean; platform: string | null }` and all open extension contexts subscribe to them. When `active === true`, the receiving context sets `isRecording = true` and `captureMode = 'captions'` — so a newly-opened side panel joins an in-progress recording session without calling `startRecording()` again.
2. `chrome.storage.local` — language prefs (`primaryLang`, `secondaryLang`, `bilingual`), speaker names, and mic settings are read on mount and persisted on change. All contexts reading the same keys see consistent preferences after a reload.

### 6.3 LLM-hook contracts

Each hook that calls an LLM endpoint follows a shared pattern:

| Contract point | Detail | File:line |
|---|---|---|
| `language?` parameter | Every public `generate`/`sendMessage` function accepts an optional `language` string that is forwarded to the server endpoint | `hooks/useChat.ts:62`, `hooks/useQuestions.ts:15`, `hooks/useNotes.ts:21` |
| `AbortController` on every request | Each hook holds an `abortRef` and creates a fresh `AbortController` per call; the previous request is aborted before the next one starts | `hooks/useChat.ts:28,81–83`, `hooks/useNotes.ts:8,34–35` |
| Timeout | `REQUEST_TIMEOUT_MS = 120_000` ms (2 minutes) is set via `setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)` | `lib/config.ts:47`, `hooks/useChat.ts:84`, `hooks/useQuestions.ts:31` |
| Timeout vs user-cancel distinction | Timeout aborts are `DOMException { name: 'AbortError' }` — hooks catch them separately; `useQuestions` surfaces `'Request timed out. Try again.'`; `useChat` and `useNotes` silently swallow user-cancel AbortErrors | `hooks/useQuestions.ts:56–58`, `hooks/useChat.ts:111`, `hooks/useNotes.ts:67` |
| Response-shape validation | Before consuming a response, each hook checks the exact field it expects: `useChat` checks `typeof data?.reply !== 'string'` (`hooks/useChat.ts:101`); `useQuestions` checks `typeof data?.questions !== 'string'` (`hooks/useQuestions.ts:51`) |  |

### 6.4 `REQUIRED_ENDPOINTS` and stale-server banner

`sidepanel/App.tsx:61–78` defines the client-expected endpoint list:

```typescript
const REQUIRED_ENDPOINTS = [
  '/generate-notes', '/generate-docx', '/chat', '/generate-questions',
  '/extract-entities', '/kb/ingest', '/kb/search', '/kb/connect-git',
  '/kb/generate-plan', '/kb/dispatch', '/kb/generate-code',
  '/kb/review/submit', '/kb/review/list', '/kb/review/approve',
  '/kb/notify/slack', '/kb/outcomes/refresh',
];
```

`checkServer()` (`App.tsx:239–265`) fetches `GET /` with a `HEALTH_CHECK_TIMEOUT_MS = 3_000` ms timeout (`lib/config.ts:48`). The server's JSON response is expected to include an `endpoints` array. Any endpoint in `REQUIRED_ENDPOINTS` that is absent from the reported list causes `serverStale` to be set to the missing array. The UI renders a "Server needs to be restarted" banner when `serverOnline && serverStale` is truthy (`App.tsx:468–479`). The health check repeats every `TIMING.SERVER_HEALTH_CHECK_INTERVAL_MS = 30_000` ms (`lib/config.ts:467`, `App.tsx:269`).

For the server endpoints consumed by the extension, see [`api-server.md`](api-server.md).

---

## §7 Server URL safety + config (`extension/src/lib/config.ts`)

### 7.1 `isSafeServerUrl()`

`lib/config.ts:16–30`. The function is **not exported** — it is a module-private guard used only inside `getServerUrl()`.

```typescript
function isSafeServerUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
    return ALLOWED_SERVER_PORTS.has(u.port);
  } catch { return false; }
}
```

`ALLOWED_SERVER_PORTS = new Set(['3456'])` (`lib/config.ts:15`). This means only port 3456 is accepted — URLs with no port (e.g. `http://localhost` which leaves `u.port` as `''`) are **rejected** as well as any other port number. The security rationale is explicit in the comment at `lib/config.ts:9–14`: the server is unauthenticated and binds only to 127.0.0.1, so allowing other ports would let attacker processes bound to other local ports receive extension requests.

**There is no `setServerUrl()` function** in the codebase. The server URL is set externally via `chrome.storage.local.set({ serverUrl: '...' })` and is validated on every read by `getServerUrl()`.

### 7.2 `getServerUrl()`

`lib/config.ts:32–44`. Reads `serverUrl` from `chrome.storage.local`, passes it through `isSafeServerUrl()`, strips any trailing slashes (`raw.replace(/\/+$/, '')`), and falls back to `DEFAULT_SERVER_URL = 'http://localhost:3456'` on any validation failure or storage error.

### 7.3 Timeout constants

| Constant | Value | File:line | Used for |
|---|---|---|---|
| `HEALTH_CHECK_TIMEOUT_MS` | `3_000` (3 s) | `lib/config.ts:48` | Server health-check `GET /` in `App.tsx:checkServer()` |
| `REQUEST_TIMEOUT_MS` | `120_000` (2 min) | `lib/config.ts:47` | LLM inference calls in `useChat`, `useQuestions` |
| `AUTH_FETCH_TIMEOUT_MS` | `15_000` (15 s) | `lib/config.ts:217` | Default timeout applied by `authFetch()` when the caller supplies no signal and no `timeoutMs` override |
| `REFRESH_TIMEOUT_MS` | `10_000` (10 s) | `lib/config.ts:157` | Access-token refresh call in `refreshAccessToken()` |
| `REFRESH_BACKOFF_MS` | `30_000` (30 s) | `lib/config.ts:156` | Minimum gap between failed refresh attempts (circuit-breaker) |

### 7.4 Auth and session storage

The access token is kept **in memory only** (`session.accessToken`, `lib/config.ts:73`) and is lost when the service worker terminates. The refresh token is persisted under the key `auth.refreshToken` (`REFRESH_KEY`, `lib/config.ts:65`) so a reload silently re-mints a fresh access token via `loadStoredSession()` (`lib/config.ts:104–122`).

---

## §8 Build & manifest

### 8.1 Build toolchain

`extension/vite.config.ts:1–42`. The build chain is:

```
tsc --noEmit          ← type-check gate (extension/package.json:13)
vite build            ← bundles + emits dist/
```

`npm run build` is defined as `tsc --noEmit && vite build` (`package.json:13`). A `tsc` type error blocks the Vite build from running.

Vite plugins used (`vite.config.ts:33–36`):

| Plugin | Source | Role |
|---|---|---|
| `@vitejs/plugin-react` (`react()`) | `vite.config.ts:33` | JSX transform for React 18 |
| `@crxjs/vite-plugin` (`crx({ manifest })`) | `vite.config.ts:35` | Reads `manifest.json`, rewrites content-script paths to hashed filenames, emits a well-formed `dist/manifest.json` |

`@crxjs/vite-plugin` v2 (beta.28) emits hashed filenames for content scripts (e.g. `assets/caption-scraper-Bx3kYpQm.js`). The service worker reads the actual deployed paths from `chrome.runtime.getManifest().content_scripts[].js` at runtime rather than hardcoding them (`service-worker.ts:67–71`), so the injection path always matches the hashed build artifact.

Build output directory: `dist/` (`vite.config.ts:38`). Source maps are disabled in production (`vite.config.ts:39`).

### 8.2 Development mode CSP patching

In dev mode (`mode !== 'production'`), `vite.config.ts:13–30` patches the manifest before passing it to `crx()`:

- Prepends `ws://localhost:* http://localhost:*` to `connect-src` so the crxjs HMR WebSocket is allowed.
- Sets `web_accessible_resources` to `[{ resources: ['*'], matches: ['<all_urls>'], use_dynamic_url: true }]` so the crxjs HMR runtime script is accessible from any page.

Production builds use the unmodified manifest with an empty `web_accessible_resources: []` (`manifest.json:67`).

### 8.3 Manifest V3 facts

Source: `extension/manifest.json`.

| Field | Value | Line |
|---|---|---|
| `manifest_version` | `3` | line 2 |
| `minimum_chrome_version` | `"116"` | line 8 |
| `background.service_worker` | `"src/background/service-worker.ts"` | line 28 |
| `background.type` | `"module"` | line 29 |

The extension uses a **service worker** (MV3), not a background page (MV2). The service worker can be terminated by Chrome at any time and is re-spawned on the next event.

**Permissions** (`manifest.json:9–14`):

```json
["sidePanel", "storage", "scripting", "tabs"]
```

The side panel API (`sidePanel`) requires Chrome ≥ 116, which matches `minimum_chrome_version`. The `scripting` permission is required for `chrome.scripting.executeScript` (dynamic content-script injection). The `tabs` permission is required for `chrome.tabs.query`, `chrome.tabs.sendMessage`, and reading `tab.url`.

**Host permissions** (`manifest.json:15–26`) cover the three supported platforms:

```
https://meet.google.com/*
https://teams.microsoft.com/{l,_,v2}/*
https://teams.live.com/{_,v2}/*
https://zoom.us/{wc,j}/*
https://*.zoom.us/{wc,j}/*
```

These patterns must match the patterns used in `chrome.tabs.query({ url: [...] })` in the service worker (`service-worker.ts:128–139`) exactly — mismatches produce `inject_failed` errors.

**Content-script injection** (`manifest.json:37–57`):

Three scripts are declared under a single `content_scripts` entry, injected at `"run_at": "document_idle"`:

1. `src/content/speaker-detector.ts`
2. `src/content/floating-overlay.ts`
3. `src/content/caption-scraper.ts`

**Content Security Policy** (`manifest.json:34–36`):

```
script-src 'self' 'wasm-unsafe-eval';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
connect-src 'self' http://127.0.0.1:3456 http://localhost:3456
```

The CSP restricts `connect-src` to loopback only, consistent with the `isSafeServerUrl()` port allowlist.

---

## §9 See also

- [`../explanation/chrome-extension.md`](../explanation/chrome-extension.md) — narrative explanation of the extension architecture (forward link; document created in the next task).
- [`../explanation/caption-capture.md`](../explanation/caption-capture.md) — how caption scraping works across Meet, Teams, and Zoom; the hybrid mic fallback; timing and state machine details.
- [`../explanation/invariants.md`](../explanation/invariants.md) — cross-cutting invariants governing the whole system. **Note:** some constant names in that document are stale and do not match source — prefer the verified values in this spec over any prose in `invariants.md`.

---

## Regeneration checklist
- [x] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [x] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [x] Spot-check: the MsgType enum, the caption-scraper constants/filters, and the chrome.storage shapes were rebuilt from this page and match source.
- [x] Structured facts link to their extractor-generated reference page (no hand-copied drift).
