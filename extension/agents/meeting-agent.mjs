//
// Logic for the integrated AI Assistant (Co-pilot mode).
//
// The user is already capturing the meeting locally:
//   - Chrome extension scrapes Meet/Teams/Zoom captions and pushes
//     to /kb/live/<sessionId>/append
//
// The agent attaches to one of those existing live sessions, reads
// the transcript every 1.5s, and — when warranted — drafts ONE
// plan-grounded question and publishes it back to the same live
// stream with source="agent-question".
//
// No bot-workers, no third-party transport — just an LLM watching
// the transcript and injecting questions into the user's UI.

import { appendCaptions, finalizeSession, getCaptionsSince, listActiveSessions } from './live-sessions.mjs';
import { draftQuestion } from './agent-prompt.mjs';
import { getPlan, getAgentPersona } from '../kb/db.mjs';
import { logger as _agentLog } from '../core/logger.mjs';

const log = _agentLog.child ? _agentLog.child({ component: 'meeting-agent' }) : _agentLog;

// ── Question-loop tunables ────────────────────────────────────────────
// Held in module scope so tests can override.  Numbers come from §6 of
// docs/meeting-agent-plan.md.
const TICK_MS                = 1500;     // how often we re-evaluate
const QUESTION_COOLDOWN_MS   = 90_000;   // min gap between asked questions
const MIN_SILENCE_MS         = 2500;     // wait after the last word
const TRANSCRIPT_WINDOW_MS   = 90_000;   // how far back to feed the LLM
const MIN_CONTEXT_CAPTIONS   = 3;        // don't draft on a single hello
const NAME_CALL_LOOKBACK     = 5;
const NAME_CALL_RE           = /\bhey\s+(agent|notes|bot)\b/i;
// Hard floor on Claude CLI invocations regardless of cooldown
// bypass.  Without this, a chatty meeting where someone says "hey
// agent" repeatedly could spawn one CLI call per 1.5s tick.
// 8s is generous (still feels responsive) but caps theoretical max
// at ~7 calls/minute, well under any plausible CLI rate limit.
const MIN_LLM_CALL_INTERVAL_MS = 8_000;

// ── Localized system-caption strings ─────────────────────────────────
// Hand-translated for each supported language so Japanese users see
// Japanese attach / briefing / detach lines in their own transcript.
// Anything not in this table falls back to English — the agent's own
// LLM-generated questions are localized via the prompt's language
// directive.  Keep the keys short and the strings short — these are
// status messages, not prose.

const I18N = {
  en: {
    attachWithPlan:    (n) => `${n} attached — listening with the active plan loaded.`,
    attachNoPlan:      (n) => `${n} attached — observing only (no active plan to ground in).`,
    detached:          ()  => 'Agent detached.',
    briefingZero:      (title, total) => `Plan loaded: "${title}" — ${total} task${total === 1 ? '' : 's'}, none currently active. I'll listen for moments where the plan helps.`,
    briefingOne:       (title, t) => `Plan loaded: "${title}" — focused on "${t}". I'll flag conflicts, missed risks, or unstated assumptions.`,
    briefingMany:      (title, list) => `Plan loaded: "${title}" — active tasks: ${list.map((t) => `"${t}"`).join(', ')}. I'll flag conflicts, missed risks, or unstated assumptions.`,
  },
  ja: {
    attachWithPlan:    (n) => `${n} が参加しました — 現在のプランを読み込み、聞いています。`,
    attachNoPlan:      (n) => `${n} が参加しました — プランがないため、観察のみ行います。`,
    detached:          ()  => 'エージェントは退出しました。',
    briefingZero:      (title, total) => `プランを読み込みました: 「${title}」 — タスク ${total} 件、現在アクティブなものはありません。プランが役立つ瞬間に注意を払います。`,
    briefingOne:       (title, t) => `プランを読み込みました: 「${title}」 — 「${t}」 に注目しています。矛盾・見落とされたリスク・暗黙の前提があれば指摘します。`,
    briefingMany:      (title, list) => `プランを読み込みました: 「${title}」 — アクティブタスク: ${list.map((t) => `「${t}」`).join('、')}。矛盾・見落とされたリスク・暗黙の前提があれば指摘します。`,
  },
};

function pickI18N(language) {
  if (!language) return I18N.en;
  const code = String(language).toLowerCase();
  if (I18N[code]) return I18N[code];
  const base = code.split('-')[0];
  return I18N[base] || I18N.en;
}

function localizeAttach(speakerName, hasPlan, language) {
  const t = pickI18N(language);
  return hasPlan ? t.attachWithPlan(speakerName) : t.attachNoPlan(speakerName);
}

// Per-session state.  Keyed by the live-session id the agent attached
// to, NOT a fresh id — so the existing /kb/live/<id> stream that the
// extension is writing to is the same stream the agent reads from and
// writes back to.
const runs = new Map();   // sessionId -> Run

// Capped map for last-dispatch diagnostics. Cap at 1000 entries: in a
// long-running server with many users this would otherwise grow without
// bound. We evict the oldest entry when the cap is reached (LRU-lite:
// Map insertion order is stable in V8 — first entry is oldest).
const LAST_DISPATCH_CAP = 1000;
const lastDispatchByUser = new Map();    // userId -> {ts, meetingUrl, result}

function setLastDispatch(userId, value) {
  if (lastDispatchByUser.size >= LAST_DISPATCH_CAP && !lastDispatchByUser.has(userId)) {
    // Evict the oldest entry. Map.keys() returns insertion order.
    const oldest = lastDispatchByUser.keys().next().value;
    lastDispatchByUser.delete(oldest);
  }
  lastDispatchByUser.set(userId, value);
}

/// Used by the bot-relay endpoint to validate that a sessionId is
/// real before accepting captions for it — and that the userId on
/// the relay matches the run's owner so a stolen bot-worker secret
/// can't write captions into arbitrary sessions.
export function getRunBySessionId(sessionId) {
  return runs.get(sessionId) || null;
}

export function getDiagnostics(userId) {
  return {
    lastDispatch: lastDispatchByUser.get(userId) || null,
    activeRuns: listRuns(userId),
  };
}

class Run {
  constructor({ sessionId, userId, planId, persona, language }) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.planId = planId;
    this.persona = persona;
    this.language = language || 'en';
    this.startedAt = Date.now();
    this.cooldownUntil = 0;
    this.recentQuestions = [];
    this.tickTimer = null;
    this.tickInFlight = false;
    // Hard floor on LLM invocations — name-call bypass shouldn't
    // let someone shouting "hey agent!" spawn one Claude CLI per
    // 1.5s tick.  See MIN_LLM_CALL_INTERVAL_MS.
    this.lastLLMCallAt = 0;
    // Set when the underlying capture finalizes mid-LLM-call so
    // the in-flight publish path knows to skip its append.
    this.finalizing = false;
    // Last decision the loop made — exposed via /kb/agent/runs so
    // both UIs can render "watching · last: no-plan-id (15s ago)"
    // instead of just "Agent attached" with no signal of what it
    // is or isn't doing.  Updated on every tick exit point.
    this.lastTickAt = null;
    this.lastDecision = null;   // { reason, score?, asked?: bool }
    // Incremental caption fetch: track the highest sequence number
    // we have seen so we can call getCaptionsSince(…, lastSeenSeq)
    // and receive only NEW captions each tick instead of the full
    // buffer.  Combined with a local rolling window we avoid
    // re-scanning captions older than TRANSCRIPT_WINDOW_MS on every
    // 1.5 s tick.  Initialized to 0 so the first tick sees all captions
    // (needed to detect the session's existence / finalization state).
    this.lastSeenSeq = 0;
    // Rolling transcript window — captions within TRANSCRIPT_WINDOW_MS.
    // Rebuilt incrementally: new captions are appended, expired ones
    // trimmed.  Never grows past MAX_CAPTIONS_PER_SESSION (2000).
    this.windowBuffer = [];
  }
}

function recordDecision(run, reason, { score = null, asked = false } = {}) {
  run.lastTickAt = Date.now();
  run.lastDecision = { reason, score, asked };
}

// ── Lifecycle ────────────────────────────────────────────────────────

/**
 * Attach the agent to one of the user's active live sessions.  If
 * `sessionId` is omitted we pick the most-recently-active one (which
 * is the common case: the user just clicked "Send agent" while the
 * extension is already capturing).
 *
 * Returns { sessionId, planId, attached } so the UI can confirm
 * which session got the agent and whether grounding will actually
 * happen.
 */
export async function dispatchAgent({
  userId, sessionId, planId, persona, language,
  meetingUrl,
}) {
  if (!userId) throw new Error('userId required');

  let resolvedSessionId = sessionId;
  if (!resolvedSessionId) {
    const sessions = listActiveSessions(userId);
    if (sessions.length === 0) {
      throw new Error('No active capture session — start recording in the extension or Mac app first.');
    }
    resolvedSessionId = sessions[0].sessionId;
  }

  // Idempotent: re-attaching to a session we're already running on
  // is a no-op (and not an error — the UI may double-click).
  if (runs.has(resolvedSessionId)) {
    const existing = runs.get(resolvedSessionId);
    return {
      sessionId: existing.sessionId,
      planId: existing.planId,
      attached: false,
      reason: 'already-attached',
    };
  }

  // Resolve the persona: explicit request body overrides anything
  // stored, but in the common case the dispatch button doesn't pass
  // one, so we fall back to the user's saved preference (if any).
  // Either path is non-fatal — null persona uses built-in defaults.
  const resolvedPersona = persona || getAgentPersona(userId) || null;

  const run = new Run({
    sessionId: resolvedSessionId,
    userId,
    planId: planId || null,
    persona: resolvedPersona,
    language,
  });
  runs.set(resolvedSessionId, run);

  // Surface the attachment as a system caption so both UIs flip to
  // "agent watching" instantly.  Speaker uses the resolved persona
  // (request body wins, then stored, then default), not the bare
  // request param — so a user with a stored "Atlas" persona who
  // clicks "Send agent" without passing one still sees "Atlas:"
  // not "Agent:".
  const speakerName = resolvedPersona?.name || 'Agent';
  appendCaptions(userId, resolvedSessionId, [{
    speaker: speakerName,
    text: localizeAttach(speakerName, !!planId, run.language),
    ts: Date.now(),
    source: 'agent-system',
  }]);

  // Pre-meeting briefing — deterministic one-liner so the user
  // immediately sees what the agent thinks is the current focus.
  // Builds trust before the first question.  Cheap (no LLM call);
  // a fancier LLM-generated summary can replace this once we have
  // dogfood data on whether briefings actually help.
  if (run.planId) {
    const briefing = buildBriefing(userId, run.planId, run.language);
    if (briefing) {
      appendCaptions(userId, resolvedSessionId, [{
        // Use run.persona (the resolved persona) not persona (the raw
        // dispatch param which may be null even when a stored persona exists).
        speaker: run.persona?.name || 'Agent',
        text: briefing,
        ts: Date.now() + 1,                 // +1ms so ordering is stable
        source: 'agent-system',
      }]);
    }
  }

  startQuestionLoop(run);

  // Record what kind of dispatch this was for the diagnose endpoint.
  // `transport` is null when we're just attaching the co-pilot to a
  // session the user is already capturing; non-null when a bot-worker
  // would actually be sent to a meeting URL.
  setLastDispatch(userId, {
    ts: Date.now(),
    sessionId: resolvedSessionId,
    meetingUrl: meetingUrl || null,
    transport: meetingUrl ? 'bot' : null,
    result: meetingUrl ? 'bot-dispatched' : 'co-pilot',
  });

  return {
    sessionId: resolvedSessionId,
    planId: run.planId,
    attached: true,
  };
}

// ── Briefing ────────────────────────────────────────────────────────
// One-line "I've read the plan, here's the active focus" message
// posted right after attach.  Deterministic by design — we don't
// want to burn a Claude CLI invocation before the user has even
// said anything, and the format is predictable enough to be
// reassuring rather than alarming.

const BRIEFING_MAX_TASKS = 3;
const BRIEFING_MAX_LEN   = 280;

function buildBriefing(userId, planId, language) {
  let plan;
  try { plan = getPlan(userId, planId); }
  catch { return null; }
  if (!plan) return null;

  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const activeStatuses = new Set(['in_progress', 'in-progress', 'pending', 'blocked']);
  const active = tasks
    .filter((t) => t && (activeStatuses.has(String(t.status || '').toLowerCase())))
    .slice(0, BRIEFING_MAX_TASKS)
    .map((t) => t.title || 'untitled')
    .filter(Boolean);

  const total = tasks.length;
  const title = (plan.title || 'the active plan').toString().trim();
  const t = pickI18N(language);
  let line;
  if (active.length === 0)        line = t.briefingZero(title, total);
  else if (active.length === 1)   line = t.briefingOne(title, active[0]);
  else                            line = t.briefingMany(title, active);
  if (line.length > BRIEFING_MAX_LEN) line = line.slice(0, BRIEFING_MAX_LEN - 1) + '…';
  return line;
}

export async function stopAgent({ userId, sessionId }) {
  const run = runs.get(sessionId);
  if (!run) return { stopped: false, reason: 'unknown-session' };
  if (run.userId !== userId) return { stopped: false, reason: 'forbidden' };
  run.finalizing = true;        // any in-flight LLM call will skip publish
  run.recentQuestions = [];     // free memory; no re-use after stop
  stopQuestionLoop(run);
  appendCaptions(run.userId, sessionId, [{
    speaker: run.persona?.name || 'Agent',
    text: pickI18N(run.language).detached(),
    ts: Date.now(),
    source: 'agent-system',
  }]);
  // Note: we deliberately do NOT finalizeSession here.  The user's
  // capture continues; we're only detaching the listener.  The live
  // session ends when the capturing client (extension/Mac app)
  // stops recording — that's when /kb/live/<id>/finalize is called.
  runs.delete(sessionId);
  return { stopped: true };
}

// ── Inspection ──────────────────────────────────────────────────────

export function listRuns(userId) {
  const out = [];
  for (const r of runs.values()) {
    if (r.userId !== userId) continue;
    out.push({
      sessionId: r.sessionId,
      planId: r.planId,
      startedAt: r.startedAt,
      lastTickAt: r.lastTickAt,
      lastDecision: r.lastDecision,
    });
  }
  return out;
}

// ── Question loop ────────────────────────────────────────────────────
// Per-run timer that, every TICK_MS, decides whether to draft a
// question.  Cheap when nothing is happening — gates run before any
// LLM call so we don't burn CLI invocations on idle meetings.

function startQuestionLoop(run) {
  if (run.tickTimer) return;
  run.tickInFlight = false;
  run.tickTimer = setInterval(() => {
    if (run.tickInFlight) return;
    run.tickInFlight = true;
    Promise.resolve(tickRun(run))
      .catch((err) => {
        log.error('agent_tick_error', {
          sessionId: run.sessionId,
          userId: run.userId,
          error: err?.message?.slice(0, 200) || String(err),
        });
      })
      .finally(() => { run.tickInFlight = false; });
  }, TICK_MS);
  run.tickTimer.unref?.();
}

function stopQuestionLoop(run) {
  if (run.tickTimer) {
    clearInterval(run.tickTimer);
    run.tickTimer = null;
  }
}

async function tickRun(run) {
  const now = Date.now();

  // Incremental fetch: only pull captions with seq > run.lastSeenSeq.
  // getCaptionsSince filters the in-memory ring buffer (max 2000 entries);
  // returning only new captions avoids re-scanning unchanged history on
  // every 1.5 s tick.  The `exists` and `finalized` meta fields are always
  // populated regardless of sinceSeq, so session-lifecycle checks work.
  //
  // NOTE: sinceSeq is a SEQUENCE NUMBER (small integer), not a timestamp.
  // The previous fix mistakenly passed a Unix-ms timestamp here, making
  // the filter `c.seq > ~1.7 trillion` which always returned zero captions
  // and silenced the agent entirely.  This version is correct.
  const fresh = getCaptionsSince(run.userId, run.sessionId, run.lastSeenSeq);
  if (!fresh?.exists) {
    recordDecision(run, 'no-session');
    return;
  }

  // Did the underlying capture session finalize?  If so, the user
  // stopped recording; clean up our loop.  Mark finalizing FIRST
  // so any in-flight LLM call from a prior tick won't try to
  // publish into the dead session.
  if (fresh.finalized) {
    run.finalizing = true;
    recordDecision(run, 'capture-stopped');
    stopQuestionLoop(run);
    runs.delete(run.sessionId);
    return;
  }

  // Append new (non-agent) captions to the run's rolling window buffer
  // and update the high-water mark so the next tick only fetches newer ones.
  const newCaptions = (fresh.captions || []).filter(
    (c) => c.source !== 'agent-system' && c.source !== 'agent-question',
  );
  if (newCaptions.length > 0) {
    run.windowBuffer.push(...newCaptions);
  }
  // Advance the high-water mark past EVERYTHING seen this tick — including
  // ticks that fetched only agent-authored captions (filtered out above).
  // fresh.sequence is the session's true max seq, so this never skips a
  // human caption; it just stops getCaptionsSince from refetching and
  // refiltering the same agent captions every ~1.5s tick.
  if (typeof fresh.sequence === 'number' && fresh.sequence > run.lastSeenSeq) {
    run.lastSeenSeq = fresh.sequence;
  }

  // Trim the window buffer to only keep captions within TRANSCRIPT_WINDOW_MS.
  // This keeps memory bounded and gives the LLM a rolling ~90 s view.
  const cutoffTs = now - TRANSCRIPT_WINDOW_MS;
  run.windowBuffer = run.windowBuffer.filter((c) => c.ts >= cutoffTs);

  const window = run.windowBuffer;
  if (window.length === 0) {
    recordDecision(run, 'no-transcript-yet');
    return;
  }

  // Name-call detection bypasses cooldown + min-context.
  const personaName = (run.persona?.name || 'Agent').toLowerCase();
  const lookback = window.slice(-NAME_CALL_LOOKBACK);
  const wasNamed = lookback.some((c) => {
    const t = (c.text || '').toLowerCase();
    return NAME_CALL_RE.test(t)
      || (personaName.length > 2 && t.includes(personaName));
  });

  if (!wasNamed && now < run.cooldownUntil) {
    const secs = Math.ceil((run.cooldownUntil - now) / 1000);
    recordDecision(run, `cooldown ${secs}s left`);
    return;
  }

  const lastTs = window[window.length - 1].ts;
  if (!wasNamed && (now - lastTs) < MIN_SILENCE_MS) {
    recordDecision(run, 'someone speaking');
    return;
  }
  if (!wasNamed && window.length < MIN_CONTEXT_CAPTIONS) {
    recordDecision(run, 'not enough context yet');
    return;
  }

  if (!run.planId) {
    recordDecision(run, 'no plan attached');
    return logCandidate(run, { shouldAsk: false, score: 0, reason: 'no-plan-id' });
  }

  // Hard rate floor — sits ABOVE plan loading too, so name-call
  // bypass can't spam CLI invocations on a meeting with no plan
  // yet either.
  const sinceLastCall = now - run.lastLLMCallAt;
  if (sinceLastCall < MIN_LLM_CALL_INTERVAL_MS) {
    const wait = Math.ceil((MIN_LLM_CALL_INTERVAL_MS - sinceLastCall) / 1000);
    return recordDecision(run, `llm rate floor (${wait}s)`);
  }

  let plan;
  try { plan = getPlan(run.userId, run.planId); }
  catch (err) {
    recordDecision(run, `plan-load-error: ${err.message?.slice(0, 40)}`);
    return logCandidate(run, { shouldAsk: false, score: 0, reason: `plan-load-error: ${err.message?.slice(0, 60)}` });
  }
  if (!plan) {
    recordDecision(run, 'plan not found');
    return logCandidate(run, { shouldAsk: false, score: 0, reason: 'plan-not-found' });
  }

  // Mark the LLM call BEFORE awaiting — if the call takes 4s and
  // the next tick fires at 3s, that tick will see the rate floor.
  run.lastLLMCallAt = now;
  const candidate = await draftQuestion({
    plan,
    transcriptWindow: window,
    recentQuestions: run.recentQuestions,
    userId: run.userId,
    personaSuffix: run.persona?.promptSuffix || null,
    language: run.language,
  });
  logCandidate(run, candidate);

  // Mid-LLM-call the underlying capture might have finalized
  // (user clicked Stop recording) or the run might have been
  // explicitly stopped.  If so, drop the publish — it would just
  // hit a finalized session and get rejected anyway, and we don't
  // want stale questions appearing post-stop.
  if (run.finalizing || !runs.has(run.sessionId)) {
    return recordDecision(run, 'session ended during draft');
  }

  if (!candidate.shouldAsk || !candidate.question) {
    // Below the confidence floor or LLM declined.  Surface the
    // score so the user understands "the agent thought, but it
    // wasn't worth asking" — not "the agent is broken."
    const why = candidate.shouldAsk === false && candidate.score
      ? `score ${candidate.score.toFixed(2)} below threshold`
      : (candidate.reason || 'declined');
    recordDecision(run, why, { score: candidate.score });
    return;
  }
  recordDecision(run, `asked (score ${candidate.score?.toFixed?.(2) || '—'})`,
                 { score: candidate.score, asked: true });



  // Publish the question to the live stream — the only "speak" path
  // in co-pilot mode.  Both UIs render it; the user decides whether
  // to ask it out loud (or click "Speak" in the Mac app for local TTS).
  appendCaptions(run.userId, run.sessionId, [{
    speaker: run.persona?.name || 'Agent',
    text: candidate.question,
    ts: now,
    source: 'agent-question',
    meta: {
      planTaskId: candidate.planTaskId || '',
      score: candidate.score,
      reason: candidate.reason || '',
    },
  }]);
  // Store question with timestamp so old entries can be age-gated.
  // Without timestamps, questions from 89 min ago would still block
  // similar questions near the end of a long meeting.
  run.recentQuestions.push({ text: candidate.question, ts: now });
  // Expire entries older than TRANSCRIPT_WINDOW_MS and hard-cap at 5
  // so the deduplication list stays relevant to the current context.
  const cutoff = now - TRANSCRIPT_WINDOW_MS;
  run.recentQuestions = run.recentQuestions
    .filter((q) => q.ts >= cutoff)
    .slice(-5);
  run.cooldownUntil = now + QUESTION_COOLDOWN_MS;
}

function logCandidate(run, c) {
  log.info('agent_candidate', {
    sessionId: run.sessionId,
    ask: c.shouldAsk,
    score: Number(c.score || 0).toFixed(2),
    reason: (c.reason || '').slice(0, 80),
    planTaskId: c.planTaskId || null,
  });
}

// Graceful shutdown hook. The server calls this on SIGTERM/SIGINT so the
// per-run tick timers stop firing and any in-flight tick marks its run as
// finalizing (so a late-returning LLM call won't publish a question into a
// session that's going away). Timers are already `unref()`d so they don't
// hold the event loop open, but leaving them running during drain wastes
// CLI invocations and can emit spurious questions mid-shutdown.
export function stopAllAgents() {
  for (const r of runs.values()) {
    r.finalizing = true;       // in-flight tick will skip publish
    stopQuestionLoop(r);
  }
  runs.clear();
  return true;
}

// For tests.
export function _resetForTests() {
  for (const r of runs.values()) stopQuestionLoop(r);
  runs.clear();
  // Diagnostic map is also module-state — clearing runs without
  // it would leak `lastDispatch` across test cases.
  lastDispatchByUser.clear();
}
