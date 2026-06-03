// NDJSON exporter — yields one {meeting, entities} record per user
// meeting.  Used by the Mac LegacyExporter on first launch to dump
// pre-Phase-1 data to .md files.  Read-only.

import * as defaultKb from './db.mjs';

function toLegacyMeeting(m) {
  const startedAt = m.date ? Date.parse(m.date) : null;
  const durationMs = (Number(m.duration_sec) || 0) * 1000;
  return {
    id: m.id,
    user_id: m.user_id,
    title: m.title,
    started_at: startedAt,
    ended_at: startedAt && durationMs ? startedAt + durationMs : null,
    transcript: m.transcript || '',
    notes: '',
    language: m.language || 'en',
    platform: 'meet',
    participants: Array.isArray(m.participants) ? m.participants : [],
  };
}

function toLegacyEntity(e) {
  const meta = e.meta || {};
  return {
    id: e.id,
    meeting_id: e.meeting_id,
    kind: e.kind,
    owner: meta.owner || null,
    text: e.text,
    due: meta.due || null,
  };
}

export async function* iterateUserMeetings({ userId, cursor, limit, _db = defaultKb }) {
  // listMeetings already supports cursor + limit on the server, but
  // the wrapper used to handle batches uniformly — keep the shape.
  const result = _db.listMeetings(userId, cursor, limit);
  const rows = Array.isArray(result) ? result : (result?.items || []);
  for (const m of rows) {
    // Per-row try/catch: one corrupt meta blob or unencodable Date
    // should not truncate the entire NDJSON stream. We yield a
    // sentinel `_error` record so the client can flag the row and
    // keep ingesting the rest of the batch.
    try {
      const entities = _db.listEntities(userId, m.id).map(toLegacyEntity);
      yield { meeting: toLegacyMeeting(m), entities };
    } catch (err) {
      yield {
        _error: true,
        meetingId: m?.id || null,
        message: err?.message?.slice(0, 200) || 'unknown',
      };
    }
  }
}
