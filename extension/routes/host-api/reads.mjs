// Host API v1 read commands on the desktop host (chat.sessions, chat.history, usage.get): pure mappers from the kb
// stores to the closed v1 shapes. Every string is re-redacted (rows can predate redaction) and clamped; never meta,
// tool output, system lines, limit configuration or a key. The gateway's respond() validates the result again.
import { clamp } from './frame.mjs';
import { HOST_API_LIMITS } from './commands.generated.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';

export const READ_LIMITS = Object.freeze({ sessionsDefault: 50, historyDefault: 100, providersMax: 10, modelsMax: 50 });
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(['ok', 'warning', 'exhausted']);
const STATUSES = new Set(['ok', 'degraded', 'paused', 'unconfigured']);
const text = (s, max) => clamp(redactSecretsForStorage(typeof s === 'string' ? s : ''), max);
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** `rows` was fetched with limit + 1, so one extra row means another page exists. */
export function sessionsOf(rows, limit, offset, phoneChatId) {
  const page = rows.slice(0, limit).filter((r) => typeof r?.id === 'string' && ID_RE.test(r.id));
  return {
    sessions: page.map((r) => ({
      id: r.id,
      title: text(r.title, 120) || 'New chat',
      updatedAt: count(Number(r.updatedAt) * 1000), // the store keeps seconds
      ...(r.id === phoneChatId ? { phoneChat: true } : {}),
    })),
    ...(rows.length > limit ? { nextOffset: offset + limit } : {}),
  };
}

export function historyOf(session, limit) {
  const fetched = session?.messages ?? [];
  const lines = fetched
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && Number.isInteger(m.seq) && m.seq >= 1)
    .slice(-limit)
    .map((m) => ({ seq: m.seq, role: m.role, content: text(m.content, 100_000) }));
  // Newest first within maxListBytes, as messagesOf in gateway.mjs: the newest line always fits alone.
  let bytes = 0;
  let start = lines.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(lines[start - 1])) + 1;
    if (start < lines.length && bytes + size > HOST_API_LIMITS.maxListBytes) break;
    bytes += size;
    start -= 1;
  }
  const messages = lines.slice(start);
  const next = start > 0 ? messages[0].seq : session?.hasMore && fetched.length ? fetched[0].seq : null;
  return { messages, ...(Number.isInteger(next) && next >= 1 ? { nextBeforeSeq: next } : {}) };
}

export function usageOf(summary) {
  const providers = Object.entries(summary?.providers ?? {}).slice(0, READ_LIMITS.providersMax).map(([provider, p]) => {
    const active = p?.active ?? {};
    const activeModel = text(active.model, 200);
    return {
      provider: text(provider, 64) || 'unknown',
      status: STATUSES.has(active.status) ? active.status : 'unconfigured',
      ...(activeModel ? { activeModel } : {}),
      models: (Array.isArray(p?.models) ? p.models : []).slice(0, READ_LIMITS.modelsMax).map((m) => {
        const label = text(m?.label, 200);
        return {
          model: text(m?.model, 200) || 'model',
          ...(label ? { label } : {}),
          state: STATES.has(m?.state) ? m.state : 'ok',
          unit: m?.unit === 'tokens' ? 'tokens' : 'runs',
          window: m?.window_kind === 'monthly' ? 'monthly' : 'daily',
          used: count(m?.used),
          limit: count(m?.limit),
          ...(Number.isFinite(m?.pct) ? { pct: Math.min(999, Math.max(0, Math.round(m.pct))) } : {}),
          resetAt: count(Date.parse(m?.resetAt)),
        };
      }),
    };
  });
  return { providers };
}
