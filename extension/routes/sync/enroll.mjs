// Desktop side of enrollment (design 5.2 as amended; schema/sync/v1/README.md "Enrollment"). One pending enrollment per
// user, in memory only: es never touches the database, the vault, a log or the store, and is zeroed when it ends. The
// claim is pinned the first time it is seen and never fetched again; the tier is the one the user picked here.
import { randomBytes } from 'node:crypto';
import { enrollKeys, newId22, openClaim, sealAck, sasCode, pairUrl } from '../../core/sync-enroll.mjs';
import { getSyncState, listSyncDevices, addSyncDevice, nextSeq } from '../../kb/sync-state.mjs';
import { ensureSyncKeys } from './keys.mjs';
import { writeDeviceWrap } from './producer.mjs';

export const ENROLL = Object.freeze({ claimMs: 120_000, confirmMs: 120_000, maxClaimBytes: 8192 });
const CLAIM_RE = /^[A-Za-z0-9_-]{22}\.bin$/;
const ACK = 'ack.bin';
const ORIGIN_RE = /^(https:\/\/[A-Za-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$/;
const pending = new Map(); // userId -> enrollment
const codeErr = (code) => Object.assign(new Error(code), { code });
const envBytes = (env) => Buffer.from(JSON.stringify(env));
const slotDir = (p) => `${p.pair.sid}/e/${p.pair.slot}`;
const webOrigin = (env) => (ORIGIN_RE.test(env.LLMIDE_SYNC_WEB_ORIGIN ?? '') ? env.LLMIDE_SYNC_WEB_ORIGIN : 'https://llm-ide.com');

function wipe(p) {
  p.es.fill(0); p.pair.es = '';
  for (const k of Object.values(p.keys)) k.fill(0);
  clearTimeout(p.timer);
}

async function kill(p, code) {
  if (p.phase !== 'waiting' && p.phase !== 'confirm') return;
  p.phase = code === 'expired' ? 'expired' : 'failed';
  p.code = code;
  wipe(p);
  await p.store.removeTree(slotDir(p)).catch(() => {});
  await p.store.removeTree(`${p.pair.sid}/d/${p.pair.dir}`).catch(() => {});
}

const claimFiles = async (p) => (await p.store.list(slotDir(p))).filter((f) => f.name !== ACK);
const view = (p) => ({ phase: p?.phase ?? 'none', sas: p?.phase === 'confirm' ? p.sas : null, name: p?.claim?.name ?? null, tier: p?.tier ?? null, code: p?.code ?? null });

export function _resetEnrollmentsForTest() { for (const p of pending.values()) wipe(p); pending.clear(); }

export async function startEnrollment(userId, { store, tier, now = Date.now(), env = process.env }) {
  if (tier !== 'web' && tier !== 'ios') throw codeErr('VALIDATION_FAILED');
  const state = getSyncState(userId);
  if (!state?.enabled) throw codeErr('SYNC_OFF');
  const old = pending.get(userId);
  if (old) await kill(old, 'replaced');
  const keys = ensureSyncKeys(userId);
  const d = store.describe();
  const es = randomBytes(16);
  const pair = { sid: state.syncId, sfp: keys.fingerprint, dir: newId22(), slot: newId22(), es: es.toString('base64url'), st: `${d.kind}:${d.root}` };
  const p = { pair, es, keys: enrollKeys(es, pair.sid, pair.slot), tier, store, openedAt: now, phase: 'waiting', code: null, claim: null, claimAt: 0, sas: null, timer: null };
  pending.set(userId, p);
  const qr = pairUrl(pair, tier, webOrigin(env));
  try { await store.put(`${pair.sid}/d/${pair.dir}/key.bin`, keys.signingSpki); } catch (e) { await kill(p, 'store'); throw e; }
  p.timer = setTimeout(() => { void kill(p, 'expired'); }, ENROLL.claimMs + ENROLL.confirmMs + 5_000);
  p.timer.unref?.();
  return { qr, expiresAt: now + ENROLL.claimMs, tier };
}

async function take(userId, p, now) {
  if (now > p.openedAt + ENROLL.claimMs) return kill(p, 'expired');
  const files = await claimFiles(p);
  if (files.length === 0) return;
  if (files.length > 1) return kill(p, 'contested');
  const f = files[0];
  if (!CLAIM_RE.test(f.name) || f.size > ENROLL.maxClaimBytes) return kill(p, 'claim_invalid');
  let claim;
  try {
    const bytes = await p.store.get(`${slotDir(p)}/${f.name}`);
    if (!bytes || bytes.length > ENROLL.maxClaimBytes) throw codeErr('claim_invalid');
    claim = openClaim({ env: JSON.parse(Buffer.from(bytes).toString('utf8')), pair: p.pair, tier: p.tier, keys: p.keys });
  } catch { return kill(p, 'claim_invalid'); }
  if (listSyncDevices(userId).some((dev) => dev.deviceId === claim.deviceId)) return kill(p, 'claim_invalid');
  p.claim = { ...claim, file: f.name };
  p.claimAt = now;
  const nD = randomBytes(16);
  const desk = ensureSyncKeys(userId);
  try {
    await p.store.put(`${slotDir(p)}/${ACK}`, envBytes(sealAck({ userId, pair: p.pair, tier: p.tier, claim, nD, keys: p.keys, signingKey: desk.signingKey, seq: nextSeq(userId, now), issuedAt: now })));
  } catch { return kill(p, 'store'); }
  p.sas = sasCode(p.keys.sas, { ...p.pair, tier: p.tier, ...claim, nD });
  nD.fill(0);
  p.phase = 'confirm';
}

export async function pollEnrollment(userId, { now = Date.now() } = {}) {
  const p = pending.get(userId);
  if (!p) return view(null);
  if (p.phase === 'waiting') await take(userId, p, now);
  else if (p.phase === 'confirm') {
    if (now > p.claimAt + ENROLL.confirmMs) await kill(p, 'expired');
    else if ((await claimFiles(p)).some((f) => f.name !== p.claim.file)) await kill(p, 'contested');
  }
  return view(p);
}

export async function confirmEnrollment(userId, { now = Date.now() } = {}) {
  const p = pending.get(userId);
  if (!p || p.phase !== 'confirm') throw codeErr('ENROLL_NOT_READY');
  if (now > p.claimAt + ENROLL.confirmMs) { await kill(p, 'expired'); throw codeErr('ENROLL_FAILED'); }
  if ((await claimFiles(p)).some((f) => f.name !== p.claim.file)) { await kill(p, 'contested'); throw codeErr('ENROLL_FAILED'); }
  const state = getSyncState(userId);
  if (!state?.enabled) throw codeErr('SYNC_OFF');
  const { deviceId, ecdhSpki, signingSpki, name } = p.claim;
  addSyncDevice(userId, { deviceId, dir: p.pair.dir, tier: p.tier, name, ecdhSpki, signingSpki, now });
  pending.delete(userId);
  p.phase = 'done';
  wipe(p);
  const dev = listSyncDevices(userId).find((x) => x.deviceId === deviceId);
  await writeDeviceWrap({ userId, store: p.store, state, keys: ensureSyncKeys(userId), dev, now }).catch(() => {});
  await p.store.removeTree(slotDir(p)).catch(() => {});
  return { deviceId };
}

export async function cancelEnrollment(userId) {
  const p = pending.get(userId);
  pending.delete(userId);
  if (p) await kill(p, 'cancelled');
}
