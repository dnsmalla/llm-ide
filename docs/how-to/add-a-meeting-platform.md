---
title: How to add a new meeting platform
applies_to: extension
---

# How to add a new meeting platform

## Goal

Make Meet Notes capture captions from a platform the scraper does not yet know about.

## Steps

1. **Find the CC DOM.** Open the platform with CC on, inspect the captions container, note the selectors used. Look for stable attributes (`data-tid`, ARIA roles) before classnames (classnames rotate).
2. **Add a reader function** in `extension/src/content/caption-scraper.ts`. It must return at most one block per speaker (the outermost / latest), filter UI noise, and use only content-based validation.
3. **Wire it into `detectPlatform()`** with a hostname match (e.g., `webex.com`).
4. **Add the host to `host_permissions` and `content_scripts.matches`** in `extension/manifest.json`.
5. **Test with multi-speaker, screen-share, and short JA captions** — see the testing checklist in [invariants](../explanation/invariants.md#testing-checklist-before-merging-caption--transcript--llm-changes).

## Verification

Real call on the new platform: multi-speaker, with screen share. The transcript should match what CC shows, one line per continuous turn, no UI noise.

## See also

- [ADR 0006 — snapshot-diff caption scraper](../decisions/0006-snapshot-diff-caption-scraper.md)
- [Caption-capture history](../explanation/caption-capture.md)
