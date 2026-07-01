---
title: "0006. Snapshot-diff caption scraper (replaces buffer/dedup heuristics)"
status: accepted
date: 2026-05-18
---

# 0006. Snapshot-diff caption scraper

## Context

Earlier versions of the scraper used per-speaker buffers, repeated-phrase de-duplication, longest-text-per-tick selection, and utterance-detection heuristics. With multiple speakers, these collided: text from one speaker contaminated another's buffer; corrections were emitted as new lines; dedup munged real repeated words ("yes yes" → "yes").

## Decision

The scraper is a snapshot-diff loop. Every 800 ms it reads what CC currently shows, and if a speaker's text changed, it emits an update with the same `sessionId` to update the same transcript line. A new session starts only on first sighting or after 5 s of silence.

## Consequences

- **Positive:** correctness is obvious — the transcript mirrors what CC shows.
- **Positive:** multi-speaker handling is implicit (each speaker has its own state slot).
- **Positive:** all the abandoned heuristics get to stay deleted; see [caption-capture history](../explanation/caption-capture.md).
- **Negative:** any platform whose CC UI we cannot read defeats the loop entirely; mic fallback exists for those.
- **Locked in:** see [invariants — caption scraper](../explanation/invariants.md#caption-scraper-extensionsrccontentcaption-scraperts).
