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
