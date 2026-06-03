-- 0004 — durable feedback log for meeting-agent questions.
--
-- Every time the question loop publishes an agent-question caption,
-- the user gets a 👍 / 👎 / 💤 affordance in the transcript popover.
-- Their verdict lands here.  Phase 3 of the agent plan tunes the
-- LLM's confidence threshold against this table — without these
-- rows, "is the agent actually useful?" is a question we have no
-- way to answer except by gut feel.
--
-- We deliberately do NOT store the question text or the LLM reason
-- here.  Those live in the in-memory live-sessions buffer and are
-- ephemeral.  This table only stores the verdict + the references
-- needed to correlate later (session id + caption seq + plan task).
-- If the user wants the full text recall we can JOIN against the
-- persisted /kb/ingest record at query time.

CREATE TABLE IF NOT EXISTS agent_feedback (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  caption_seq  INTEGER NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('useful','noise','later')),
  plan_task_id TEXT,
  score        REAL,
  recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, session_id, caption_seq)
);

-- Quick lookups for the stats endpoint: "what fraction of recent
-- questions did each user mark useful?"  Bounded scan thanks to the
-- recorded_at index.
CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_time
  ON agent_feedback(user_id, recorded_at);

-- Lookups by plan task — Phase 3 wants "which task is this LLM
-- best at grounding in?" so it can weight tasks by precision.
CREATE INDEX IF NOT EXISTS idx_agent_feedback_task
  ON agent_feedback(user_id, plan_task_id);
