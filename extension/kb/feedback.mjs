// Meeting-agent question feedback — 👍 / 👎 / 💤 verdicts on agent
// questions, plus aggregate stats and per-plan-task breakdowns.
//
// Persisted so the Phase 3 confidence-tuning step can answer "is the
// LLM actually asking useful questions?" with data instead of vibes.
//
// Extracted from kb/db.mjs as part of the modularization sweep.
// db.mjs re-exports every public function so existing callers
// (`kb.recordAgentFeedback(...)`) keep working unchanged.

import { getDb, lazyPrepare, requireUser } from './db.mjs';

const VALID_VERDICTS = new Set(['useful', 'noise', 'later']);

/// Upsert a verdict on a single agent-question caption. The
/// (user_id, session_id, caption_seq) tuple is the natural key
/// (one verdict per question per user); a re-call overwrites.
export function recordAgentFeedback(userId, { sessionId, captionSeq, verdict, planTaskId, score }) {
  requireUser(userId);
  if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId required');
  if (!Number.isFinite(captionSeq))                throw new Error('captionSeq required');
  if (!VALID_VERDICTS.has(verdict))                throw new Error(`invalid verdict: ${verdict}`);
  const db = getDb();
  lazyPrepare(db, `
    INSERT INTO agent_feedback (user_id, session_id, caption_seq, verdict, plan_task_id, score)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, session_id, caption_seq) DO UPDATE SET
      verdict      = excluded.verdict,
      plan_task_id = excluded.plan_task_id,
      score        = excluded.score,
      recorded_at  = datetime('now')
  `).run(
    userId, sessionId, Math.floor(captionSeq), verdict,
    typeof planTaskId === 'string' && planTaskId ? planTaskId.slice(0, 64) : null,
    Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
  );
}

/// Aggregate stats for the user — drives the §10 telemetry view and
/// eventually the Phase 3 threshold tuner.
export function agentFeedbackStats(userId, { sinceDays = 30 } = {}) {
  requireUser(userId);
  const db = getDb();
  const sinceOffsetSec = -Math.max(1, Math.floor(sinceDays)) * 86400;
  const counts = lazyPrepare(db,
    `SELECT verdict, COUNT(*) AS n
     FROM agent_feedback
     WHERE user_id = ? AND recorded_at >= datetime('now', ? || ' seconds')
     GROUP BY verdict`,
  ).all(userId, String(sinceOffsetSec));
  const byVerdict = { useful: 0, noise: 0, later: 0 };
  for (const r of counts) byVerdict[r.verdict] = r.n;
  const total = byVerdict.useful + byVerdict.noise + byVerdict.later;
  // Average score among "useful" vs "noise" — the precision proxy
  // we'll tune the threshold against.
  const avgRow = lazyPrepare(db,
    `SELECT verdict, AVG(score) AS avg, COUNT(*) AS n
     FROM agent_feedback
     WHERE user_id = ? AND recorded_at >= datetime('now', ? || ' seconds') AND score IS NOT NULL
     GROUP BY verdict`,
  ).all(userId, String(sinceOffsetSec));
  const avgScore = {};
  for (const r of avgRow) avgScore[r.verdict] = r.avg;
  return {
    total,
    byVerdict,
    usefulRate: total ? byVerdict.useful / total : null,
    avgScore,
    sinceDays,
  };
}
