# Extension storage audit (2026-10-31)

Rule under test ([data-lifecycle](../../kits/data-lifecycle.md), R1; MASTER-PLAN Chrome extension): the extension **stores nothing** of its own. Classes: (1) UI/config preference allowed, (2) capture-in-flight buffer that may exist only until handed to the Mac app, (3) violation (chats, transcripts, notes, participants persisted after hand-off).

Method: grep of `chrome.storage`, `localStorage`, `sessionStorage`, `indexedDB`, `openDB` over `extension/src` (content scripts and the service worker use none; the caption scraper keeps its per-speaker state in memory only, invariants untouched). Manifest permission `storage` is the only grant.

## Inventory

| Where | Key | Holds | Class | Verdict |
|---|---|---|---|---|
| `lib/config.ts` | `serverUrl` | server base URL | 1 | keep |
| `lib/config.ts` | refresh-token key | auth refresh token (silent re-login) | 1 (credential) | keep; cleared on logout (`config.ts` remove) |
| `lib/config.ts` | `LLMIDE_DEBUG` (localStorage) | debug flag | 1 | keep |
| `App.tsx` | `HINT_DISMISSED_KEY` | boolean | 1 | keep |
| `App.tsx` | `agent.enabled` (localStorage) | boolean | 1 | keep |
| `useTranscript.ts` | `primaryLang`, `secondaryLang`, `bilingual` | language prefs | 1 | keep |
| `hooks/useAudioDevices.ts` | `micDeviceId`, `micVolume` | device prefs | 1 | keep |
| `components/ConnectorsSettings.tsx` | per-field keys (`useStored`) | connector settings and tokens typed in the panel | 1, with a note | keep; tokens are sent only to the user's own 127.0.0.1 server. Better home is the server vault (follow-up, not a data-lifecycle violation) |
| `components/QuestionsView.tsx` | `questions.prefs.v1` (localStorage) | question types **and pinned participant names** | 1 for types, **3 for names** | **fixed**: names no longer persisted |
| `useTranscript.ts` | `speakerNames` | speaker id to display name, across all meetings | **3** (participant names outlive the capture) | **fixed**: in memory only, legacy key purged on load |
| `lib/capture-store.ts` + `capture-live.ts` | `transcriptDraft:<id>`, `draftStage:<id>` | the capture until the server proves an identical copy that the Mac acked | 2 | keep; deleted on verified ack (tests in `tests/capture-store.test.ts`) |
| `lib/legacy-chat.ts` / `useChat.ts` | `chatMessages`, `unifiedChatSessionId` | removed buffer from the old chat; read only to offer Export, deleted after the server was reached or the user discarded | 2 (migration) | keep until users drained; chat itself stores nothing (`unified-chat.ts`) |

## Violations fixed (this commit)

1. `speakerNames` was written to `chrome.storage.local` on every rename and merged into every new capture, so participant names persisted forever. Now held in React state; the capture draft already carries them while the capture is in flight. `purgeLegacyMeetingKeys` removes the old key on panel load.
2. The Questions "customize" pin saved participant names to localStorage. Now only the question types persist; an old blob is rewritten without names on load (`parseQuestionPrefs`/`serializeQuestionPrefs`, `lib/ui-prefs.ts`, tests `extension/tests/ui-prefs.test.ts`, 4 passing).

## Residual risks (not changed, need a decision)

- **Flag-off retention.** When the server has no ack protocol (`LLMIDE_LIVE_ACK` off, stage `no-ack`) up to `MAX_RETAINED = 50` finished captures stay in `chrome.storage.local` indefinitely, and finalizing is refused at the cap. This is deliberate data-loss protection, but it is persisted meeting content. It disappears once the ack flag is on by default (lta.mode default, MASTER-PLAN Y2 checks). Decision for the user: turn the ack protocol on by default, then delete the `no-ack` stage.
- A capture whose storage write failed is held in memory only and is lost on panel close unless the user downloads it (UI warns; correct trade-off).
- Connector tokens in `chrome.storage.local` (above).

## Are the reads sufficient? (data-lifecycle section 8 open item)

Every server path the extension calls was matched against `ALL_ENDPOINTS` in `extension/server.mjs`. All are served: `/kb/chat/sessions` (+ `/:id`), `/agent/v2/session|stream|decision`, `/kb/search`, `/kb/stats`, `/kb/issues`, `/kb/conflict-questions`, `/kb/agent/dispatch|runs|stop`, `/kb/live/sessions`, `/kb/live/:id`, `/kb/live/:id/status|finalize|append`, `/generate-notes|questions|docx`, `/extract-entities`, `/kb/plan/save`, `/kb/connect-*`. The extension reaches "the Mac app" by calling the Node server on `127.0.0.1:3456`, which is the backend the Mac app launches (or adopts); there is no separate Mac HTTP API.

Findings:
- The capture hand-off path exists and is what section 8 could not find: `lib/capture-live.ts` streams to `POST /kb/live/:id/append`, finalizes with the full `captions` (`/finalize`, v86), and polls `GET /kb/live/:id/status`; the Mac acks through `POST /kb/live/:id/ack`; `useDraftRelease.ts` drops the draft on a verified ack. The extension does not call `/kb/ingest` (it is only listed in `REQUIRED_ENDPOINTS` in `App.tsx`, a stale entry; harmless, but it means an old server missing it is flagged).
- Gap: the extension has **no read for archived meetings once the Mac archives them** (live-then-archive deletes server rows; `/kb/search` only sees what is indexed and the extension has no call into `note_index` or a "get note" endpoint). That is fine for the capture and chat roles, but any "past meeting" view in the side panel would have to go through the Mac app or a future index route. Not needed by any current screen.
- Gap: when the Mac app is not running the server may be down, and the side panel then shows the offline state (USER-CHECKLIST B7, unverified in a run).
