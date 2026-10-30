-- K1 Phase 6b review fixes (docs/spec/session-router.md).
-- 1. handoff_note was never written: the Mac file's summary is the single copy, so the column is dropped.
ALTER TABLE chat_session_route DROP COLUMN handoff_note;
-- 2. last_engine: which engine answered the chat's last turn ('claude' | 'adapter' | ''). The warm map is capped
--    and expires, so "an adapter turn ran after the last Claude turn" cannot be read from it; this can.
ALTER TABLE chat_session_route ADD COLUMN last_engine TEXT NOT NULL DEFAULT '';
