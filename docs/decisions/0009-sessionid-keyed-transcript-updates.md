---
title: "0009. Transcript updates are keyed by sessionId, not appended"
status: accepted
date: 2026-05-18
---

# 0009. sessionId-keyed transcript updates

## Context

Caption messages arrive many times for the same continuous speaking turn (CC keeps refining the text). Appending each one would render the same utterance ten times.

## Decision

Every `CAPTION_FINAL` message carries a `sessionId`. The side panel groups updates into one segment by `sessionId` — same id replaces the existing segment, new id appends. The scraper picks a new `sessionId` only on first sighting or after a 5 s gap.

## Consequences

- **Positive:** the rendered transcript matches one-line-per-turn intuition.
- **Positive:** persistence is simple — we store segments, each segment is one row.
- **Negative:** consumers downstream (notes, plan, agent) must treat `segments` as the source of truth, not the rendered string.
- **Locked in:** see [invariants — message protocol, useTranscript](../explanation/invariants.md#message-protocol-extensionsrclibmessagests).
