---
title: Chrome runtime message protocol
source: extension/src/lib/messages.ts
---

<!-- generated from extension/src/lib/messages.ts - do not edit by hand -->

# Chrome runtime message protocol

Messages flow between the content script, the service worker, the side panel, and the floating popup. All messages share the `Message` discriminated union and the `MsgType` enum.

## Types

| Type | Direction | Payload fields |
|---|---|---|
| `START_CAPTION_SCRAPING` | Side panel → content script | - |
| `STOP_CAPTION_SCRAPING` | Side panel → content script | - |
| `GET_CAPTION_STATUS` | Side panel → content script | - |
| `PING` | Side panel → content script | - |
| `OPEN_POPUP` | Content script → service worker (popup management) | - |
| `CAPTION_FINAL` | Content script → side panel | `speaker`, `text`, `timestamp`, `sessionId` |
| `CAPTION_STATUS` | Content script → side panel | `active`, `platform` |
| `CAPTION_SCRAPER_READY` | Content script → side panel | `platform` |
| `ACTIVE_SPEAKER` | Content script → side panel | `speaker` |
| `PARTICIPANTS_LIST` | Content script → side panel | `participants` |
| `POST_CHAT` | Content script → side panel | `text` |
