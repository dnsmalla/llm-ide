// Synthetic "legacy" server data for the live-then-archive migration tests
// (docs/superpowers/plans/2026-10-29-live-then-archive.md, T0.4).
//
// Seeds a DB that the caller already opened through the REAL migrations
// (kb/db.mjs getDb) with the shapes the legacy server wrote: `meetings` +
// `entities` + FTS rows via ingestMeeting, a plan linked to a meeting, the
// extension's rolling `chat_sessions`/`chat_messages`, an `agent_sessions`
// mapping and `session_memory` for a Mac chat id. Everything is generated;
// nothing is copied from a real database. The caller owns the DB path (use a
// temp path, never the live data.db).
import { ingestMeeting } from '../../../kb/meetings.mjs';
import { savePlan } from '../../../kb/plans.mjs';
import { createChatSession, appendChatMessage } from '../../../kb/chat-sessions.mjs';
import { getOrCreateAgentSession, markAgentSessionUsed } from '../../../kb/agent-sessions.mjs';
import { appendSessionMemory } from '../../../kb/session-memory.mjs';
import { getDb } from '../../../kb/db.mjs';

export const MAC_CHAT_ID = '3f1b2c4d-0000-4000-8000-00000000a001';

export function seedLegacyDb(userId) {
  const meetings = [
    { id: 'm-legacy-en', title: 'Budget review', date: '2026-08-01T10:00:00.000Z', duration: 1800,
      participants: ['Alice', 'Bob'], projectId: 'proj-a',
      transcript: '[10:00:01] Alice: we should raise the budget\n[10:00:09] Bob: agreed, rollback plan first',
      entities: [
        { id: 'e-1', kind: 'decision', text: 'Raise the budget', quote: 'we should raise the budget' },
        { id: 'e-2', kind: 'action', text: 'Write rollback plan' },
        { id: 'e-3', kind: 'blocker', text: 'Waiting on finance' },
      ] },
    { id: 'm-legacy-ja', title: '設計レビュー', date: '2026-08-02T01:00:00.000Z', duration: 900,
      participants: ['田中'], projectId: 'proj-a',
      transcript: '[10:00:01] 田中: 予算と設計を確認します', entities: [] },
    // A key read aloud: ingestMeeting redacts it (secretsRedacted in meta).
    { id: 'm-legacy-secret', title: 'Ops sync', date: '2026-08-03T10:00:00.000Z', duration: 60,
      participants: [], projectId: undefined,
      transcript: 'the key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh ok', entities: [] },
  ];
  for (const m of meetings) ingestMeeting(userId, { ...m, language: 'en' });

  savePlan(userId, { id: 'plan-legacy-1', meetingId: 'm-legacy-en', title: 'Budget rollout',
    goal: 'ship the budget change', tasks: [{ id: 't-1', title: 'Draft rollback plan' }] });

  const ext = createChatSession(userId, { title: 'Extension chat', surface: 'extension', mode: 'transcript' });
  appendChatMessage(userId, ext.id, { role: 'user', content: 'what was decided about the budget?' });
  appendChatMessage(userId, ext.id, { role: 'assistant', content: 'You decided to raise the budget.' });

  const db = getDb();
  getOrCreateAgentSession(db, userId, MAC_CHAT_ID, 'explorer');
  markAgentSessionUsed(db, userId, MAC_CHAT_ID, { sdkSessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', model: 'm', mode: 'ask' });
  appendSessionMemory(userId, MAC_CHAT_ID, ['prefers short answers']);

  return { meetingIds: meetings.map((m) => m.id), extChatId: ext.id, macChatId: MAC_CHAT_ID, planId: 'plan-legacy-1' };
}
