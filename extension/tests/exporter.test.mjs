import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { iterateUserMeetings } = await import('../kb/exporter.mjs');

test('iterateUserMeetings yields meetings + entities for the given user', async () => {
  const stub = {
    meetings: [
      { id: 'm1', user_id: 'u1', title: 'A',
        date: '2026-05-08T14:00:00Z', duration_sec: 1500,
        transcript: 'hi', language: 'en', participants: [] },
      { id: 'm2', user_id: 'u2', title: 'B',
        date: '2026-05-09T14:00:00Z', duration_sec: 600,
        transcript: 'hi', language: 'en', participants: [] },
    ],
    entities: [
      { id: 'e1', meeting_id: 'm1', kind: 'action',
        text: 'ship', meta: { owner: 'alice', due: null } },
    ],
    listMeetings(userId, cursor, limit) {
      return this.meetings.filter(m => m.user_id === userId).slice(0, limit);
    },
    listEntities(_userId, meetingId) {
      return this.entities.filter(e => e.meeting_id === meetingId);
    }
  };

  const collected = [];
  for await (const rec of iterateUserMeetings({ userId: 'u1', cursor: null, limit: 100, _db: stub })) {
    collected.push(rec);
  }
  assert.equal(collected.length, 1);
  assert.equal(collected[0].meeting.id, 'm1');
  assert.equal(collected[0].entities[0].kind, 'action');
  assert.equal(collected[0].entities[0].owner, 'alice');
});
