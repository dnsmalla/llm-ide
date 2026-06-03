---
title: "0010. Side panel and floating popup share one React bundle"
status: accepted
date: 2026-05-18
---

# 0010. Shared React bundle for side panel and floating popup

## Context

Users sometimes want the panel as a floating, always-on-top window during a meeting (e.g., to keep notes visible while screen-sharing the meeting tab). Forking the UI into two component trees would mean every feature gets implemented twice.

## Decision

The floating popup is a `type: 'popup'` Chrome window that mounts the same `src/sidepanel/index.html` bundle. State synchronisation is via `chrome.runtime.onMessage` broadcasts and `chrome.storage.local`. A mount-time `GET_CAPTION_STATUS` query catches the popup up if it opens after recording started.

## Consequences

- **Positive:** features land once; both surfaces get them.
- **Positive:** CSS adapts to the resized window via `flex-wrap` and media queries.
- **Negative:** every new piece of UI state must persist through `chrome.storage.local` or broadcast — local React state alone will not sync.
- **Locked in:** see [invariants — floating popup, useChat persistence](../explanation/invariants.md#floating-popup-chromewindowscreate).
