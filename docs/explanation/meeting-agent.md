---
title: Meeting agent
status: stable
---

# Meeting agent

**Status:** stable · co-pilot mode
**Owner:** Dinesh
**Surfaces affected:** `extension/` (server + Chrome ext), `mac/`

---

## 1. Goal in one sentence

An AI **co-pilot** that watches the live transcript the user is
already capturing, drafts one well-timed plan-grounded question
when warranted, and surfaces it in both surfaces — so the user can
choose to ask it themselves.

The agent is never a participant in the meeting. It does not speak,
does not appear in the participant list, and is not visible to anyone
except the local user.

> ### Historical note — what we tried and dropped
>
> An earlier prototype (v0.1) sent a third-party meeting bot
> (Recall.ai) into the call to capture audio and speak responses
> aloud. That approach was removed because it required a paid SaaS
> API key, which conflicts with [ADR 0001 — Claude CLI, not API
> key](../decisions/0001-claude-cli-not-api-key.md): the rule that
> nothing in this codebase accepts third-party API keys. The current
> co-pilot architecture reads from the same live caption stream the
> user is already producing.

## 2. Why this, why now

We already have:

- Plan persistence and Q&A generation (`/kb/generate-questions`,
  `/kb/plans`, `/kb/plan/:id`).
- Live caption streaming and cross-client mirroring (`/kb/live/*`).
- Two surfaces (Chrome extension, Mac app) that already render those
  streams in real time.

The agent is the part that contributes to the meeting: a focused
service, not a new product line.

## 3. Non-goals (explicit)

- ❌ A Google Meet replacement. Users keep using their existing
  conferencing tool.
- ❌ Custom WebRTC, mobile apps, calendar integration.
- ❌ A bot that joins the meeting as a participant.
- ❌ TTS / spoken output. The agent surfaces questions in the UI;
  the user decides whether to ask them aloud.
- ❌ Multi-language, multi-region from day one. English + single
  region for the MVP.
- ❌ The agent maintaining a long monologue. One question at a time,
  triggered, with a hard cooldown.

## 4. Architecture

```text
              ┌─────────────────────────┐
              │   Google Meet (tab)     │
              │   captions panel        │
              └────────────┬────────────┘
                           │ DOM scrape (snapshot/diff)
                           │ see ADR 0006
                ┌──────────▼──────────┐
                │ Chrome extension    │
                │ content script      │
                └──────────┬──────────┘
                           │ POST /kb/live/:sessionId/append
                           ▼
                ┌─────────────────────┐
                │  Local Node server  │
                │  (extension/        │
                │   server.mjs)       │
                │                     │
                │  ┌───────────────┐  │
                │  │ meeting-agent │  │  ticks every 1.5s,
                │  │ loop          │  │  reads recent window,
                │  │               │  │  drafts a question via
                │  │               │  │  the Claude CLI
                │  └───────┬───────┘  │
                │          │ append   │
                │          ▼          │
                │      /kb/live/      │
                │      :sessionId     │
                │      (KB store)     │
                └──────────┬──────────┘
                           │ GET /kb/live/:sessionId?since=N
                  ┌────────┴────────┐
                  ▼                 ▼
           Chrome extension     Mac app
           side panel           Transcript view
           (renders live)       (renders live)
```

Key properties:

- **No third-party transport.** No bot joins the meeting. The
  extension scrapes the captions panel the user has open and POSTs
  caption batches to the local server — see [ADR 0006](../decisions/0006-snapshot-diff-caption-scraper.md).
- **Single source of truth.** Everything — user captions, agent
  questions, summaries — lives on the `/kb/live/<sessionId>` stream.
  Both surfaces render the same stream.
- **No new API surface for the agent.** The agent reuses
  `POST /kb/live/:sessionId/append` to post its questions back into
  the same transcript, marked with a distinct `source` field so the
  UI can style them.

## 4.5 LLM access pattern — Claude CLI, not API keys

This codebase **does not call the Anthropic API directly**. Every
LLM call goes through `runClaude(prompt, { userId? })` exported by
`extension/agents/runtime.mjs`, which `execFile`s the local `claude`
CLI authenticated as the user via `claude login`. See [ADR
0001](../decisions/0001-claude-cli-not-api-key.md).

The meeting agent follows the same pattern. The question loop in
`extension/agents/meeting-agent.mjs` calls `draftQuestion()` from
`agent-prompt.mjs`, which `runClaude`s exactly like `planner.mjs`,
`risk.mjs`, and `codegen.mjs`. No Anthropic SDK, no API key.

## 5. The agent loop (the actual logic)

```text
on session detected (sessionId picked from listActiveSessions):
    plan = getPlan(active or selected by user)
    cooldown = 0
    last_speech_end_ts = now()

every 1.5s:
    if cooldown > 0:                              continue
    if (now() - last_speech_end_ts) < 2.5s:       continue   # let humans talk
    window = getCaptionsSince(sessionId, last 90s)
    if window.length < 3:                          continue  # not enough signal
    if was_named_in_recent_window("agent"|"notes"|"bot"):
        force = true
    candidate = draftQuestion({                    # runClaude (CLI)
        plan, transcriptWindow: window,
        recentQuestions: ring_buffer(5),
        userId,
    })
    if candidate.score < 0.7 and not force:       continue
    appendCaptions(sessionId, [{
        speaker: "Agent",
        text: candidate.text,
        source: "agent-question",
    }])
    cooldown = 90s
```

Key design choices:

- **One question per minute, max** (90s cooldown). Bad agents
  produce too much noise.
- **Confidence floor** (0.7). Better to stay silent than to surface
  a low-quality question.
- **Name-call override.** "Hey agent, what do you think?" bypasses
  the cooldown and confidence gates.
- **Reuse `/kb/generate-questions` prompt shape** for plan grounding.

## 6. Surface impact — where each thing lives

### `extension/` (server)

- `agents/meeting-agent.mjs` — the loop above.
- `agents/agent-prompt.mjs` — `draftQuestion()`; calls `runClaude`.
- `agents/live-sessions.mjs` — KB helpers
  (`appendCaptions`, `getCaptionsSince`, `listActiveSessions`,
  `finalizeSession`).
- Endpoints used: `POST /kb/live/:sessionId/append`,
  `GET /kb/live/:sessionId?since=N`,
  `POST /kb/live/:sessionId/finalize`.
- No new HTTP routes are required for the agent itself; it operates
  in-process alongside the live KB.

### `extension/` (Chrome extension)

- Content script scrapes Meet captions (snapshot/diff per [ADR
  0006](../decisions/0006-snapshot-diff-caption-scraper.md)) and
  POSTs batches to `/kb/live/:sessionId/append`.
- Side panel polls `/kb/live/:sessionId?since=N` and renders both
  user captions and agent-question rows (the latter styled via the
  `source="agent-question"` field).

### `mac/`

- TranscriptView polls the same `/kb/live/:sessionId?since=N` and
  renders agent-question rows with a distinct color/icon.

## 7. Risks & open questions

| Risk | Mitigation |
|---|---|
| **Agent surfaces bad questions, users hide it.** | Confidence gate + cooldown + dogfood. The question loop is a tuning knob; keep telemetry on every drafted-vs-shown candidate. |
| **Caption scraper UI rot** when Meet rotates DOM class names. | Snapshot/diff strategy ([ADR 0006](../decisions/0006-snapshot-diff-caption-scraper.md)) tolerates churn; covered by tests. |
| **Latency** between human pause and agent question feels stale. | 1.5s tick + 2.5s min-silence + CLI round-trip = ~3–5s. Acceptable for a non-spoken hint surface. |
| **Speaker mis-attribution** from caption-panel guesses. | Fall back to "Speaker" generically; don't hallucinate names. |
| **Mobile / native conferencing clients aren't covered.** | Out of scope. The Mac app's local AX capture (if enabled) is the only non-browser path. |

## 8. Telemetry we need

- `agent.candidate_drafted` (score, would_have_surfaced: bool)
- `agent.question_surfaced` (text, score, plan_section_id)
- `agent.named` (when a human said the agent's name in the captions)
- `agent.cooldown_skipped` (why)

These plug into the existing logging path. Without them we can't
tune the question loop.

## 9. What this design explicitly does NOT include

- A meeting bot, a participant, or anything that joins the call.
- TTS / spoken output of any kind.
- A third-party transcript provider — captions come from the
  meeting UI the user already has open.
- A new HTTP API surface — the agent reuses `/kb/live/*`.
