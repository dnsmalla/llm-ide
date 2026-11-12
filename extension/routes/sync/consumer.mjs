// Inbox consumer at the fixed read-only ceiling (design 6; relay design 5.2, D2). Every inbox file is untrusted:
// size, then signature by the REGISTERED device key, then a closed schema; record-before-execute; the turn runs only
// through startHostTurn (auto_read_only, phone chat, extension workspace) and an approval request is never answered
// from here. Nothing decrypted is logged.
import { createPublicKey } from 'node:crypto';
import { open, seal, deviceKeys } from '../../core/sync-envelope.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';
import { getSyncState, listSyncDevices, recordRequest, finishRequest, countRequestsSince, nextSeq } from '../../kb/sync-state.mjs';
import { getDb } from '../../kb/db.mjs';
import { getQuickChatId, setQuickChatId } from '../../kb/host-api-devices.mjs';
import { getMember, classRefusal } from '../../kb/members.mjs';
import { usedUsdMonthForProject } from '../../kb/project-usage.mjs';
import { projectFrameAuthority } from '../host-api/projects.mjs';
import { ensureSyncKeys, previousRoot } from './keys.mjs';
import { folderPresent } from './registry.mjs';

// One lifetime for a queued prompt and for its reply: a request is accepted for as long as the desktop keeps
// replies (7 days), so a prompt queued while the desktop was away is still answered (F10).
const OUTBOX_DAYS = 7;

export const LIMITS = Object.freeze({ maxFileBytes: 65536, maxText: 4000, maxAgeMs: OUTBOX_DAYS * 86_400_000, maxSkewMs: 600_000, perDrain: 5, perDay: 50, turnMs: 600_000, outboxDays: OUTBOX_DAYS });
const NAME_RE = /^([0-9]{13})-([A-Za-z0-9_-]{22})\.bin$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const REQUEST_KEYS = ['class', 'requestId', 'text', 'v'];
const REQUEST_KEYS_V2 = ['class', 'projectId', 'requestId', 'text', 'v'];
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // the Host API project id pattern

/** v1: exactly [class, requestId, text, v]. v2 adds a mandatory projectId (a client with no project sends v1). */
export function parseRequest(plain) {
  let o;
  try { o = JSON.parse(Buffer.from(plain).toString('utf8')); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const keys = Object.keys(o).sort().join();
  if (o.v === 1 ? keys !== REQUEST_KEYS.join() : o.v === 2 ? keys !== REQUEST_KEYS_V2.join() : true) return null;
  if (o.class !== 'chat.send' || !ID_RE.test(o.requestId)) return null;
  if (typeof o.text !== 'string' || o.text.length < 1 || o.text.length > LIMITS.maxText) return null;
  if (o.v === 2) {
    if (typeof o.projectId !== 'string' || !PROJECT_ID_RE.test(o.projectId)) return null;
    return { requestId: o.requestId, text: o.text, projectId: o.projectId };
  }
  return { requestId: o.requestId, text: o.text };
}

export function projectAllowed(userId, projectId) {
  const db = getDb();
  if (classRefusal(getMember(db, userId), 'model.ask')) return false;
  return projectFrameAuthority(db, userId, 'chat.send', { projectId }, { usedUsd: (id) => usedUsdMonthForProject(db, userId, id) }).ok;
}

const defaultDeps = {
  turn: async (args) => (await import('../agent-v2.mjs')).startHostTurn(args),
  cancel: async (userId, id) => (await import('../agent-v2.mjs')).cancelChatTurn(userId, id),
  // projectId null = the global phone chat; else that project's 'ask' phone chat, as the Host API's quickChatFor makes it.
  phoneChatId: async (userId, projectId = null) => {
    const have = getQuickChatId(userId, projectId, 'ask');
    if (have) return have;
    const id = (await import('../../kb/chat-sessions.mjs')).createChatSession(userId, { title: 'Phone chat', surface: 'any', mode: 'agent', ...(projectId ? { projectId } : {}) }).id;
    setQuickChatId(userId, id, projectId, 'ask');
    return id;
  },
  // The same check the Host API gateway runs on a chat.send frame that names a project: the member's team class,
  // then the project row, its grant (role / max_mode) and USD cap.
  projectAllowed: (userId, projectId) => projectAllowed(userId, projectId),
};

async function runTurn(userId, text, deps, projectId = null) {
  const chatSessionId = projectId ? await deps.phoneChatId(userId, projectId) : await deps.phoneChatId(userId);
  let reply = '';
  let failure = null;
  const timer = setTimeout(() => { failure ??= 'turn_failed'; void deps.cancel(userId, chatSessionId); }, LIMITS.turnMs);
  timer.unref?.();
  try {
    await deps.turn({ userId, chatSessionId, message: text, ...(projectId ? { projectId } : {}), onEvent: (e) => {
      if (e?.type === 'delta' && typeof e.text === 'string') reply += e.text;
      else if (e?.type === 'approval_request') { failure ??= 'needs_approval'; void deps.cancel(userId, chatSessionId); }
      else if (e?.type === 'error') failure ??= 'turn_failed';
    } });
  } catch { failure ??= 'turn_failed'; } finally { clearTimeout(timer); }
  if (failure) await deps.cancel(userId, chatSessionId).catch?.(() => {});
  return failure ? { ok: false, code: failure } : { ok: true, text: redactSecretsForStorage(reply).slice(0, 100_000) };
}


/** Startup sweep: a row can be left `running` when the core dies mid-turn. The inbox file is gone, so without this the
 *  device would wait forever. Answer `turn_failed` through the same sealed reply path, then mark the row failed. A store
 *  that is not available leaves the row for the next start instead of silently answering nowhere. */
export async function sweepStuckRequests({ now = Date.now(), storeFor } = {}) {
  const rows = getDb().prepare("SELECT user_id, device_id, request_id FROM sync_requests WHERE state = 'running'").all();
  let swept = 0;
  for (const row of rows) {
    const state = getSyncState(row.user_id);
    const dev = state && listSyncDevices(row.user_id).find((d) => d.deviceId === row.device_id);
    const store = state && dev && storeFor?.(row.user_id);
    if (!store) continue;
    try {
      const keys = ensureSyncKeys(row.user_id);
      const dk = deviceKeys(keys.root, { userId: row.user_id, desktopId: state.syncId, deviceId: dev.deviceId }, keys.epoch);
      const base = `${state.syncId}/d/${dev.dir}`;
      if (!(await folderPresent(store, base))) { finishRequest(row.user_id, row.device_id, row.request_id, 'failed'); continue; }
      const env = seal({ header: { purpose: 'reply', userId: row.user_id, desktopId: state.syncId, from: state.syncId, to: dev.deviceId, epoch: keys.epoch, session: '', seq: nextSeq(row.user_id, now), issuedAt: now, tier: '' },
        key: dk.reply, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId: row.request_id, ok: false, code: 'turn_failed' })), signingKey: keys.signingKey });
      await store.put(`${base}/out/${row.request_id}.bin`, Buffer.from(JSON.stringify(env)));
      finishRequest(row.user_id, row.device_id, row.request_id, 'failed');
      swept += 1;
    } catch { /* leave it running for the next sweep */ }
  }
  return { swept };
}

export async function drainOnce({ userId, store, now = Date.now(), deps = defaultDeps }) {
  const out = { ran: 0, refused: 0, replied: 0 };
  const state = getSyncState(userId);
  if (!state?.enabled) return out;
  const keys = ensureSyncKeys(userId);
  const prev = previousRoot(userId, now);
  for (const dev of listSyncDevices(userId)) {
    const base = `${state.syncId}/d/${dev.dir}`;
    const dk = deviceKeys(keys.root, { userId, desktopId: state.syncId, deviceId: dev.deviceId }, keys.epoch);
    const verifyKey = createPublicKey({ key: dev.signingSpki, format: 'der', type: 'spki' });
    const prevDk = prev && deviceKeys(prev.root, { userId, desktopId: state.syncId, deviceId: dev.deviceId }, prev.epoch);
    const writeReply = async (requestId, body, { key = dk.reply, epoch = keys.epoch } = {}) => {
      if (!(await folderPresent(store, base))) return; // revoked or deleted during the turn: never recreate the folder
      const env = seal({ header: { purpose: 'reply', userId, desktopId: state.syncId, from: state.syncId, to: dev.deviceId, epoch, session: '', seq: nextSeq(userId, now), issuedAt: now, tier: '' },
        key, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId, ...body })), signingKey: keys.signingKey });
      await store.put(`${base}/out/${requestId}.bin`, Buffer.from(JSON.stringify(env)));
      out.replied += 1;
    };
    const files = (await store.list(`${base}/in`)).sort((a, b) => (a.name < b.name ? -1 : 1));
    let taken = 0;
    for (const f of files) {
      const path = `${base}/in/${f.name}`;
      const m = NAME_RE.exec(f.name);
      if (!m || f.size > LIMITS.maxFileBytes) { await store.remove(path); out.refused += 1; continue; }
      if (taken >= LIMITS.perDrain) break;
      const bytes = await store.get(path);
      let env; let req = null; let stale = false; let opened = false;
      try {
        env = JSON.parse(Buffer.from(bytes).toString('utf8'));
        stale = !!prevDk && env?.epoch === prev.epoch;
        const pt = open({ env, key: stale ? prevDk.request : dk.request, verifyKey,
          expect: { purpose: 'request', userId, desktopId: state.syncId, from: dev.deviceId, to: state.syncId, epoch: stale ? prev.epoch : keys.epoch } });
        opened = true;
        req = parseRequest(pt);
      } catch { req = null; }
      if (!req || req.requestId !== m[2]) {
        // A request that opened under the registered key but has a bad schema gets a refusal; a forged one gets silence.
        if (opened) await writeReply(m[2], { ok: false, code: 'refused' }, stale ? { key: prevDk.reply, epoch: prev.epoch } : {}).catch(() => {});
        await store.remove(path); out.refused += 1; continue;
      }
      const fresh = recordRequest(userId, dev.deviceId, req.requestId, now);
      await store.remove(path);
      if (!fresh) continue; // replay: already answered or failed, never re-run
      taken += 1;
      if (stale) { await writeReply(req.requestId, { ok: false, code: 'stale_epoch' }, { key: prevDk.reply, epoch: prev.epoch }); finishRequest(userId, dev.deviceId, req.requestId, 'failed'); continue; }
      if (env.issuedAt < now - LIMITS.maxAgeMs || env.issuedAt > now + LIMITS.maxSkewMs) {
        await writeReply(req.requestId, { ok: false, code: 'expired' }); finishRequest(userId, dev.deviceId, req.requestId, 'failed'); continue;
      }
      if (countRequestsSince(userId, dev.deviceId, now - 86_400_000) > LIMITS.perDay) {
        await writeReply(req.requestId, { ok: false, code: 'quota' }); finishRequest(userId, dev.deviceId, req.requestId, 'failed'); continue;
      }
      if (req.projectId && !(await Promise.resolve(deps.projectAllowed?.(userId, req.projectId)).catch(() => false))) {
        await writeReply(req.requestId, { ok: false, code: 'project_unavailable' }); finishRequest(userId, dev.deviceId, req.requestId, 'failed'); continue;
      }
      const result = await runTurn(userId, req.text, deps, req.projectId ?? null);
      out.ran += 1;
      await writeReply(req.requestId, result.ok ? { ok: true, text: result.text, finishedAt: now } : { ok: false, code: result.code });
      finishRequest(userId, dev.deviceId, req.requestId, result.ok ? 'done' : 'failed');
    }
    const cutoff = now - LIMITS.outboxDays * 86_400_000;
    for (const f of await store.list(`${base}/out`)) if (f.mtimeMs < cutoff) await store.remove(`${base}/out/${f.name}`);
  }
  return out;
}
