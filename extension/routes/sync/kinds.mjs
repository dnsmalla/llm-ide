// Snapshot kinds (design 4.2): a fixed allow-list, every string re-redacted and clamped as routes/host-api/reads.mjs
// does, trimmed from the oldest end to one padding bucket. Kind names only ever appear inside the ciphertext.
import { MAX_FRAME } from '../../core/sync-envelope.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';
import { listChatSessions, getChatSession } from '../../kb/chat-sessions.mjs';
import { listMeetingSummaries, listEntitiesForMeetings } from '../../kb/meetings.mjs';
import { listPlans, getPlan } from '../../kb/plans.mjs';
import { usageSummary } from '../../kb/usage.mjs';
import { getDb } from '../../kb/db.mjs';
import { getQuickChatId } from '../../kb/host-api-devices.mjs';
import { usageOf } from '../host-api/reads.mjs';

export const KINDS = Object.freeze(['chats', 'meetings', 'plans', 'usage']);
export const DEPTH = Object.freeze({ sessions: 20, messages: 30, meetings: 50, notes: 40, plans: 30, tasks: 100 });

const text = (s, max) => {
  const t = redactSecretsForStorage(typeof s === 'string' ? s : '');
  return t.length > max ? t.slice(0, max) : t;
};
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);

/** Newest items first; drop from the end (oldest) until the frame fits one bucket. */
function frame(kind, items, now) {
  let kept = items;
  let truncated = false;
  for (;;) {
    const buf = Buffer.from(JSON.stringify({ v: 1, kind, generatedAt: now, truncated, items: kept }));
    if (buf.length <= MAX_FRAME) return buf;
    truncated = true;
    if (kept.length <= 1) return Buffer.from(JSON.stringify({ v: 1, kind, generatedAt: now, truncated, items: [] }));
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.8)));
  }
}

export function buildKinds(raw, now) {
  const chats = (raw.sessions ?? []).slice(0, DEPTH.sessions).map((s) => ({
    id: String(s.id), title: text(s.title, 120) || 'New chat', updatedAt: num(s.updatedAt),
    ...(s.id === raw.phoneChatId ? { phoneChat: true } : {}),
    messages: (s.messages ?? []).filter((m) => m?.role === 'user' || m?.role === 'assistant').slice(-DEPTH.messages)
      .map((m) => ({ seq: m.seq, role: m.role, content: text(m.content, 8000) })),
  }));
  const meetings = (raw.meetings ?? []).slice(0, DEPTH.meetings).map((m) => ({
    id: String(m.id), title: text(m.title, 200), date: text(m.date, 40), durationSec: num(m.duration_sec),
    participants: (Array.isArray(m.participants) ? m.participants : []).slice(0, 20).map((p) => text(typeof p === 'string' ? p : p?.name, 120)),
    notes: (raw.entities?.[m.id] ?? []).slice(0, DEPTH.notes).map((e) => ({ kind: text(e.kind, 40), text: text(e.text, 500) })),
  }));
  const plans = (raw.plans ?? []).slice(0, DEPTH.plans).map((p) => ({
    id: String(p.id), title: text(p.title, 200), goal: text(p.goal, 2000), updatedAt: num(p.updatedAt),
    tasks: (p.tasks ?? []).slice(0, DEPTH.tasks).map((t) => ({ title: text(t.title, 300), status: text(t.status, 40), owner: text(t.owner, 120),
      due: t.due ? text(String(t.due), 40) : null, milestone: text(t.milestone, 120), risk: text(t.risk, 40) })),
  }));
  return {
    chats: frame('chats', chats, now),
    meetings: frame('meetings', meetings, now),
    plans: frame('plans', plans, now),
    usage: Buffer.from(JSON.stringify({ v: 1, kind: 'usage', generatedAt: now, truncated: false, items: [usageOf(raw.usage)] })),
  };
}

export function loadKinds(userId, now = Date.now()) {
  const sessions = listChatSessions(userId, { limit: DEPTH.sessions })
    .map((s) => ({ ...s, messages: getChatSession(userId, s.id, { messageLimit: DEPTH.messages * 2 })?.messages ?? [] }));
  const meetings = listMeetingSummaries(userId, DEPTH.meetings);
  const entities = listEntitiesForMeetings(userId, meetings.map((m) => m.id));
  const plans = listPlans(userId, DEPTH.plans).map((p) => getPlan(userId, p.id)).filter(Boolean);
  return buildKinds({ sessions, phoneChatId: getQuickChatId(userId), meetings, entities, plans, usage: usageSummary(getDb(), userId) }, now);
}
