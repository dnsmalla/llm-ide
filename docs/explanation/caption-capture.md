---
title: Caption capture — design and history
status: stable
---

# Caption capture — design and history

> Why the caption pipeline has its current shape. For the operational rules ("never reintroduce X"), see [Engineering invariants — caption scraper](invariants.md#caption-scraper-extensionsrccontentcaption-scraperts).

## Core philosophy: mirror CC, nothing more

The caption scraper does exactly one thing: it reads what the platform's built-in closed captions (CC) currently show, compares that to what it last saw, and emits an update when something changed. The speech recognition itself is the platform's problem — Google Meet, Microsoft Teams, and Zoom all handle it far better than the extension ever could. The scraper's job is to faithfully mirror that output, not to augment or second-guess it.

The scraper maintains a per-speaker state map (`Map<speaker, { sessionId, text, lastSeen }>`). When a speaker is seen for the first time — or after a silence gap of more than 5 seconds (`SESSION_GAP_MS = 5_000`) — a new `sessionId` is minted. Subsequent text changes from the same speaker within that window are emitted with the same `sessionId`, so the side panel updates that single transcript segment in place rather than appending a new line.

This approach is sufficient because CC is already doing the speech recognition. The scraper adds no recognition of its own: it reads, diffs, and reports. The Microphone / Web Speech API path exists only as a fallback for platforms or environments where CC isn't available.

Stale per-speaker state is pruned after `MAX_BLOCK_AGE_MS = 15_000` ms of inactivity. The scraper loop runs every `SCRAPE_INTERVAL_MS = 800` ms. If a tick reads the same text as the previous tick for a given speaker, the scraper silently updates `lastSeen` but does not emit — preventing spurious duplicate segments in the transcript.

## Iteration history

### Iteration 1 — buffer and dedup

The first implementation accumulated per-speaker text buffers across ticks. As CC text grew, it was appended to the buffer; a repeated-phrase dedup pass trimmed phrases that appeared more than once. A "longest text per tick" selection heuristic chose the most complete caption block from the DOM at each interval, and an utterance-detection step tried to infer when a speaking turn had ended so the buffer could be flushed as a finalized line.

In practice this produced cascading bugs, especially in multi-speaker meetings. One speaker's buffer could be contaminated by late CC updates from another speaker that arrived in the same tick. When a speaker self-corrected mid-sentence — a normal CC behaviour — the old and new text were both present briefly in the DOM; the heuristics would emit the corrected text as a new line rather than replace the old one. Deduplication of repeated phrases also broke legitimate speech patterns: a genuine "yes, yes" or "もう一度、もう一度" was silently collapsed to a single occurrence.

Short captions (below an arbitrarily chosen minimum length) were dropped entirely, which made the scraper invisible to natural Japanese responses like `はい。` (3 characters).

### Iteration 2 — snapshot-diff (current)

The current design abandons per-tick state accumulation entirely. Every 800 ms the scraper calls the active platform reader, receives the current set of `{ speaker, text }` blocks, and compares each speaker's text to the last-emitted value in the state map.

If the text is unchanged, no message is sent. If it changed, the scraper emits a `CAPTION_FINAL` message with the existing `sessionId` (updating the segment in place) or a fresh `sessionId` if the silence gap has elapsed (starting a new segment). The side panel receives these and calls `setState` on the matching segment, collapsing a full turn's evolution into one visible line.

Key constants:

- `SCRAPE_INTERVAL_MS = 800` — one snapshot every 800 ms
- `SESSION_GAP_MS = 5_000` — silence threshold before a new segment begins
- `MAX_BLOCK_AGE_MS = 15_000` — stale speaker state is dropped

## Anti-patterns we revisit every six months

These are approaches that seem reasonable, have been tried, and have caused regressions. They appear on a regular basis in PRs and agent suggestions because they look like sensible improvements in isolation.

**`dedupeRepeatedPhrases` and similar text-munging.** With a single speaker this works; with multiple concurrent speakers the buffers cross-contaminate. One speaker's text appears in another's window, the dedup pass fires incorrectly, and the transcript loses real speech. The snapshot-diff approach avoids the problem structurally — there is no cross-speaker buffer.

**"Longest text per tick" or "prefix-sentence dropping".** These were workarounds for reading the wrong DOM level: when the scraper picked up a parent wrapper element rather than the innermost caption text node, longer text from a sibling appeared more complete. The real fix is `hasSmallerCaptionChild` in `readMeetCaptions`, which skips wrapper elements that have a caption-bearing child. Reintroducing these heuristics masks that structural check without solving the underlying issue.

**Restricting the scan to a viewport band (e.g., bottom 40%).** CC captions are rendered at the bottom of the screen in normal view, so this looks safe. During screen share the layout shifts and captions migrate. The correct approach is content-based filtering (`isValidCaption()` checks text against known UI patterns) combined with a generous top-toolbar exclusion, not a positional band.

**Tying the scraper to one platform.** Historically the scraper was written with only Meet in mind, and Teams / Zoom were afterthoughts bolted on. Every platform-specific assumption now lives in a dedicated reader function (`readMeetCaptions`, `readTeamsCaptions`, `readZoomCaptions`) and `detectPlatform()` dispatches to the right one. Single-platform assumptions break silently when running on a different host.

**Raising minimum caption length above 1.** A guard against empty strings is valid; a guard of 10 or 20 characters is not. Japanese participants routinely produce single-word or single-character acknowledgements (`はい。` is 3 characters; `え` is 1). A minimum length above 1 drops these silently.

**Single-selector lock-in for Meet.** Google Meet's generated CSS class hashes (e.g. `.nMcdL.bj4p3b`) rotate on deploys. Tying the reader to a single selector means the scraper silently stops capturing after a Meet update. The reader maintains a cascade of fallback selectors; if the primary selector returns nothing, the next is tried before concluding that CC is absent.

## Platform readers

### Google Meet

Meet renders a Material icon named `groups` on any caption block that combines three or more active speakers. When read via `innerText`, this icon name appears either as a leading line or as an inline prefix on the speaker label, depending on DOM structure. The scraper normalises both shapes using `GROUP_ICON_RE` before counting caption lines, then requires exactly two cleaned lines (speaker name and caption text). The `groups` word is not added to `ICON_PATTERN` because `\bgroups\b` can appear inside legitimate speaker strings and would incorrectly reject those captions.

Combined-speaker suffixes — `& N others` (English) and `他N名` (Japanese) — are stripped by `COMBINED_SPEAKER_RE` and `COMBINED_SPEAKER_JA` in `sanitizeSpeaker()`, so the stored speaker name is the primary speaker only, not `"真鍋勇介 & 6 others"`.

### Microsoft Teams

Teams uses stable `data-tid="closed-caption-*"` attributes on its CC elements. These survive UI reflows and style updates, making them significantly more reliable than Meet's hashed class selectors. The Teams reader targets these attributes directly without a fallback cascade.

### Zoom web

Zoom's web client exposes caption text in the DOM and the reader handles it similarly to Meet. Older Zoom desktop clients are not supported: they host the meeting UI in a native wrapper that does not expose the DOM to a browser extension content script.

## Cross-references

- [Engineering invariants — caption scraper section](invariants.md#caption-scraper-extensionsrccontentcaption-scraperts)
- [ADR 0006 — snapshot-diff caption scraper](../decisions/0006-snapshot-diff-caption-scraper.md)
- [ADR 0009 — sessionId-keyed transcript updates](../decisions/0009-sessionid-keyed-transcript-updates.md)
