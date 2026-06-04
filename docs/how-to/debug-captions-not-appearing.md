---
title: How to debug "no captions appearing"
applies_to: extension
---

# How to debug "no captions appearing"

## Goal

Localise why the side panel shows zero captions during a meeting.

## Steps

1. **Confirm CC is on in the meeting.** The scraper mirrors CC; without CC there is no input.
2. **Check the side panel's Diagnostics tab.** `captionsReceived` should increment as you speak.
3. **Enable debug logging** in the meeting tab's DevTools console:
   ```js
   localStorage.setItem('LLMIDE_DEBUG', '1');
   ```
   Then reload the meeting tab.
4. **Look for the scraper logs.** You should see one block per 800 ms with the matched DOM container.
5. **Common causes:**
   - Extension loaded *after* the tab — service worker auto-injects, but if you see `service-worker.ts: PING timeout`, reload the tab.
   - Platform DOM rotated classnames — the scraper has fallback selectors; if all fail, see [add-a-meeting-platform.md](add-a-meeting-platform.md).
   - Microphone mode rather than CC mode — Settings → Capture mode.

## Verification

`captionsReceived` increments in Diagnostics; segments appear in the Transcript tab.

## See also

- [Caption-capture history](../explanation/caption-capture.md)
- [Engineering invariants — caption scraper](../explanation/invariants.md#caption-scraper-extensionsrccontentcaption-scraperts)
