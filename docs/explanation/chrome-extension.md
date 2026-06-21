---
title: Chrome extension
status: draft
---

# Chrome extension

> Orientation to the browser surface and how it connects to the Mac app and AI pipeline. For the rebuild-grade contracts (message protocol, caption-scraper constants/filters, storage shapes, service worker, build), see [`../spec/chrome-extension.md`](../spec/chrome-extension.md).

!!! info "Rebuild-grade detail"
    Exact contracts (message protocol, caption-scraper constants/filters, storage shapes, service worker, build) are in [`../spec/chrome-extension.md`](../spec/chrome-extension.md).

## Three contexts, one pipeline

The extension is a Manifest V3 extension built with React + Vite. At runtime it occupies three browser contexts that communicate by message-passing:

**Content scripts** run inside the meeting tab (Google Meet, Microsoft Teams, Zoom). They read the platform's built-in closed captions from the DOM and forward caption events to the side panel. They also inject a small floating status overlay into the page during recording. Content scripts cannot access extension storage directly; they route everything through messages.

**Service worker** is the MV3 background context. It is ephemeral — Chrome can terminate and re-spawn it at any time. Its jobs are: injecting the content scripts into meeting tabs when recording starts, routing `START_CAPTION_SCRAPING` / `STOP_CAPTION_SCRAPING` messages between the side panel and content scripts, and handling the `OPEN_POPUP` message (described below). It has no persistent state of its own; session data lives in `chrome.storage.local`.

**Side panel** is the primary user-facing UI — a React application that opens in Chrome's native side panel alongside the meeting tab. It hosts the live transcript view, the AI chat interface, the notes generator, and settings. All LLM calls originate here via `fetch` to the local server.

## Capture → ingest → AI flow (browser side)

1. The user clicks "Record" in the side panel.
2. The side panel sends `START_CAPTION_SCRAPING` to the service worker.
3. The service worker injects the content scripts into the active meeting tab (if not already present) and forwards the message.
4. The caption scraper content script begins polling the platform's CC DOM every ~800 ms and emits `CAPTION_FINAL` messages as speakers' captions change.
5. The side panel receives each `CAPTION_FINAL` and updates the live transcript segment for that speaker in place (using the `sessionId` to route updates to the right line).
6. When the user stops recording, the side panel sends the completed transcript to the local Mac app server (`POST /generate-notes`, `/chat`, etc.) for AI processing.

For the detailed caption scraping mechanics — snapshot-diff design, per-speaker state, silence gaps, platform readers — see [`caption-capture.md`](caption-capture.md).

## Hybrid CC / mic capture stance

The extension strongly prefers the platform's built-in closed captions over microphone capture. CC is already doing the speech recognition; the extension simply mirrors its output. The mic / Web Speech API path activates only when the active tab is not a supported meeting platform (Meet, Teams, or Zoom). In that case the side panel falls back to `SpeechRecognition` for audio capture.

This is a deliberate design stance: CC accuracy, speaker attribution, and language handling are all better left to the platform than reimplemented in the extension.

## `OPEN_POPUP` — deep-linking to the Mac app, not a popup window

When a content script sends `OPEN_POPUP`, the service worker opens Chrome's native **side panel** for that window and then deep-links into the native macOS app by calling the server's `/launch-app` endpoint, which issues an `llmide://` URI redirect.

There is **no `chrome.windows.create({ type: 'popup' })` call** in the extension. The floating-popup pattern was removed. The `OPEN_POPUP` message name is historical; its effect today is side-panel open + Mac app launch.

## What lives where

| Concern | Location |
|---|---|
| Caption scraping | Content script (`content/caption-scraper.ts`) |
| Speaker detection | Content script (`content/speaker-detector.ts`) |
| In-page status overlay | Content script (`content/floating-overlay.ts`) |
| Message routing, script injection | Service worker (`background/service-worker.ts`) |
| Live transcript, AI chat, settings | Side panel (`sidepanel/`) |
| Persistence (transcripts, prefs, auth) | `chrome.storage.local` via `lib/storage.ts` + `lib/config.ts` |
| Server URL safety | `lib/config.ts` (`isSafeServerUrl()`, localhost port 3456 only) |

## Cross-references

- [`caption-capture.md`](caption-capture.md) — deep narrative on the caption scraping design, iteration history, and anti-patterns
- [`../spec/chrome-extension.md`](../spec/chrome-extension.md) — rebuild-grade contracts: every constant, filter, storage key, and message payload
- [`invariants.md`](invariants.md) — cross-cutting engineering invariants
