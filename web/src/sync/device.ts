// The browser's side of the sync v1 device contract (schema/sync/v1/README.md "Enrollment" items 1-6; design 4.3-4.4,
// 5.3). Every byte read from storage is verified with the desktop key pinned by the QR's sfp before use, and persisted
// state moves only after a file verified. The device writes only its sealed claim and sealed requests, each new unique.
import { b64u, unb64u, utf8 } from "./wire.ts";
import { fail, hex, importVerify, open, seal, sha256, unwrapSync, type SyncEnvelope } from "./envelope.ts";
import { deviceIdOf, enrollKeys, newId22, openAck, p256Spki, sasCode, sealClaim, type EnrollKeys, type Pair } from "./enroll.ts";
import { generateDeviceKeys, type DeviceKeyPairs, type LinkedDevice } from "./keystore.ts";
import { KINDS, type Snapshot } from "./kinds.ts";

export interface DeviceStore { get(path: string): Promise<Uint8Array | null>; put(path: string, bytes: Uint8Array, mkdirFrom?: number): Promise<void> }
export type BlobCache = Map<string, { sha256: string; frame: unknown }>;
export const MAX_TEXT = 4000;
export const PREV_REPLY_MS = 86_400_000;
export const REPLY_CODES = ["expired", "quota", "needs_approval", "turn_failed", "refused", "stale_epoch"] as const;
export type Reply = { v: 1; requestId: string; ok: true; text: string; finishedAt: number }
  | { v: 1; requestId: string; ok: false; code: (typeof REPLY_CODES)[number] };
export interface Enrolling {
  pair: Pair; keys: EnrollKeys; dev: DeviceKeyPairs; deviceId: string; name: string; claimPath: string; claimBytes: Uint8Array;
  desktopSpki: Uint8Array; desktopVerify: CryptoKey; userId: string | null;
}

const td = new TextDecoder("utf-8", { fatal: true });
function json(bytes: Uint8Array, code: string): any { try { return JSON.parse(td.decode(bytes)); } catch { return fail(code); } }
const exactKeys = (o: unknown, keys: string[]) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();
const safeInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const base = (d: { sid: string; dir: string }) => `${d.sid}/d/${d.dir}`;
const BLOB_FILE = /^s\/[0-9a-f]{32}\.bin$/;
const HEX64 = /^[0-9a-f]{64}$/;
const claimOf = (e: Enrolling) => ({ deviceId: e.deviceId, ecdhSpki: e.dev.ecdhSpki, signingSpki: e.dev.signingSpki, name: e.name });
const verifyKeys = new WeakMap<LinkedDevice, Promise<CryptoKey>>();
function verifyKeyOf(d: LinkedDevice): Promise<CryptoKey> {
  let k = verifyKeys.get(d);
  if (!k) { k = importVerify(d.desktopSpki); verifyKeys.set(d, k); }
  return k;
}

/** Contract 4c: write the claim; a retry writes the same name and bytes again, never a second claim. */
export const putClaim = (store: DeviceStore, e: Enrolling) => store.put(e.claimPath, e.claimBytes, 1);

/** Contract 4a-4b: pin the desktop key by sfp, make the device keys and seal the claim (nothing is written). */
export async function prepareClaim(store: DeviceStore, pair: Pair, { name, now }: { name: string; now: number }): Promise<Enrolling> {
  const spki = await store.get(`${pair.sid}/d/${pair.dir}/key.bin`);
  if (!spki || b64u(await sha256(spki)) !== pair.sfp) fail("bad_desktop_key");
  let desktopVerify: CryptoKey;
  try { desktopVerify = await p256Spki(spki!); } catch { return fail("bad_desktop_key"); }
  const es = unb64u(pair.es);
  const keys = await enrollKeys(es, pair.sid, pair.slot);
  es.fill(0);
  const dev = await generateDeviceKeys();
  const env = await sealClaim({ pair, tier: "web", name, ecdhSpki: dev.ecdhSpki, signingSpki: dev.signingSpki, signingKey: dev.signingPrivate, issuedAt: now, keys });
  const e: Enrolling = { pair: { ...pair, es: "" }, keys, dev, deviceId: await deviceIdOf(dev.signingSpki), name, claimPath: `${pair.sid}/e/${pair.slot}/${newId22()}.bin`,
    claimBytes: utf8(JSON.stringify(env)), desktopSpki: new Uint8Array(spki!), desktopVerify, userId: null };
  return e;
}

/** Contract 4d: the 6-digit code to show, or null while there is no ack. Throws on a forged ack or one for another claim. */
export async function readAck(store: DeviceStore, e: Enrolling): Promise<string | null> {
  const bytes = await store.get(`${e.pair.sid}/e/${e.pair.slot}/ack.bin`);
  if (!bytes) return null;
  const { userId, nD } = await openAck({ env: json(bytes, "bad_envelope"), pair: e.pair, tier: "web", claim: claimOf(e), keys: e.keys, desktopVerifyKey: e.desktopVerify });
  e.userId = userId;
  const sas = await sasCode(e.keys.sas, { ...e.pair, tier: "web", ...claimOf(e), nD });
  nD.fill(0);
  return sas;
}

function checkWrapHeader(env: SyncEnvelope, sid: string, userId: string) {
  if (!env || env.tier !== "web" || env.from !== sid || env.desktopId !== sid || env.userId !== userId) fail("bad_wrap");
}

/** Contract 4e: the first wrap.bin, verified with the pinned key; the linked record, or null while there is none. */
export async function readFirstWrap(store: DeviceStore, e: Enrolling, { megaEmail }: { megaEmail: string }): Promise<LinkedDevice | null> {
  if (!e.userId) return null;
  const bytes = await store.get(`${e.pair.sid}/d/${e.pair.dir}/wrap.bin`);
  if (!bytes) return null;
  const env = json(bytes, "bad_envelope") as SyncEnvelope;
  checkWrapHeader(env, e.pair.sid, e.userId);
  const keys = await unwrapSync({ env, ecdhPrivate: e.dev.ecdhPrivate, deviceEcdhSpki: e.dev.ecdhSpki, desktopSigningSpki: e.desktopSpki,
    verifyKey: e.desktopVerify, currentEpoch: 0, deviceId: e.deviceId });
  return { v: 1, sid: e.pair.sid, dir: e.pair.dir, st: e.pair.st, tier: "web", name: e.name, deviceId: e.deviceId, userId: e.userId,
    ...e.dev, desktopSpki: e.desktopSpki, epoch: env.epoch, keys, prevReply: null, manifestSeq: 0, reqSeq: 0, pending: [], megaEmail,
    box: e.pair.bi && e.pair.bs ? { clientId: e.pair.bi, clientSecret: e.pair.bs } : undefined };
}

/** Contract 5: take wrap.bin when it is for a newer epoch. false = nothing newer. The old reply key stays 24 h. */
async function readNewerWrap(store: DeviceStore, d: LinkedDevice, now: number): Promise<boolean> {
  const bytes = await store.get(`${base(d)}/wrap.bin`);
  if (!bytes) return fail("removed");
  const env = json(bytes, "bad_envelope") as SyncEnvelope;
  checkWrapHeader(env, d.sid, d.userId);
  if (!safeInt(env.epoch) || !(env.epoch > d.epoch)) return false;
  const keys = await unwrapSync({ env, ecdhPrivate: d.ecdhPrivate, deviceEcdhSpki: d.ecdhSpki, desktopSigningSpki: d.desktopSpki,
    verifyKey: await verifyKeyOf(d), currentEpoch: d.epoch, deviceId: d.deviceId });
  d.prevReply = { epoch: d.epoch, key: d.keys.reply, until: now + PREV_REPLY_MS };
  d.keys = keys;
  d.epoch = env.epoch;
  return true;
}

/** C5: a manifest more than this far past `validUntil` is not merely stale — its keys may have rotated. */
export const STALE_MANIFEST_MS = 7 * 86_400_000;

/** Design 4.3: manifest (rollback-checked, epoch-checked), then each named blob by its SHA-256, then its envelope. */
export async function readSnapshot(store: DeviceStore, d: LinkedDevice, now: number, cache: BlobCache = new Map()): Promise<Snapshot | null> {
  const raw = await store.get(`${base(d)}/manifest.bin`);
  if (!raw) {
    if (!(await store.get(`${base(d)}/key.bin`))) fail("removed");
    return null;
  }
  const env = json(raw, "bad_envelope") as SyncEnvelope;
  if (!safeInt(env?.epoch)) fail("bad_envelope");
  if (env.epoch > d.epoch && !(await readNewerWrap(store, d, now))) fail("bad_epoch");
  if (env.epoch < d.epoch) fail("rollback");
  const verifyKey = await verifyKeyOf(d);
  const expect = { userId: d.userId, desktopId: d.sid, from: d.sid, to: d.deviceId, epoch: d.epoch, session: "", tier: "" as const };
  const m = json(await open({ env, key: d.keys.manifest, verifyKey, expect: { ...expect, purpose: "manifest" } }), "bad_manifest");
  if (!exactKeys(m, ["v", "manifestSeq", "epoch", "generatedAt", "validUntil", "kinds"]) || m.v !== 1 || m.epoch !== d.epoch || m.manifestSeq !== env.seq
    || ![m.manifestSeq, m.generatedAt, m.validUntil].every(safeInt) || !m.kinds || typeof m.kinds !== "object" || Array.isArray(m.kinds)) fail("bad_manifest");
  if (m.manifestSeq < d.manifestSeq) fail("rollback");
  if (m.validUntil + STALE_MANIFEST_MS < now) fail("stale_manifest");
  const kinds: Record<string, unknown> = {};
  const keep = new Set<string>();
  for (const [kind, e] of Object.entries(m.kinds as Record<string, any>)) {
    if (!(KINDS as readonly string[]).includes(kind) || !exactKeys(e, ["file", "seq", "sha256"]) || !BLOB_FILE.test(e.file) || !safeInt(e.seq) || !HEX64.test(e.sha256)) fail("bad_manifest");
    const ck = `${d.epoch}:${e.file}`;
    keep.add(ck);
    const hit = cache.get(ck);
    if (hit && hit.sha256 === e.sha256) { kinds[kind] = hit.frame; continue; }
    const bytes = await store.get(`${base(d)}/${e.file}`);
    if (!bytes) fail("updating");
    if (hex(await sha256(bytes!)) !== e.sha256) fail("bad_blob");
    const frame = json(await open({ env: json(bytes!, "bad_envelope"), key: d.keys.snapshot, verifyKey, expect: { ...expect, purpose: "snapshot", seq: e.seq } }), "bad_snapshot");
    if (!frame || frame.v !== 1 || frame.kind !== kind || !Array.isArray(frame.items) || typeof frame.truncated !== "boolean" || !safeInt(frame.generatedAt)) fail("bad_snapshot");
    cache.set(ck, { sha256: e.sha256, frame });
    kinds[kind] = frame;
  }
  for (const k of [...cache.keys()]) if (!keep.has(k)) cache.delete(k);
  d.manifestSeq = m.manifestSeq;
  return { generatedAt: m.generatedAt, validUntil: m.validUntil, manifestSeq: m.manifestSeq, kinds: kinds as Snapshot["kinds"] };
}

/** Design 4.4: the only class a device may queue (read-only ceiling, design 6). */
export async function sendRequest(store: DeviceStore, d: LinkedDevice, text: string, now: number): Promise<string> {
  if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) fail("bad_text");
  const requestId = newId22();
  const env = await seal({ header: { purpose: "request", userId: d.userId, desktopId: d.sid, from: d.deviceId, to: d.sid, epoch: d.epoch, session: "", seq: d.reqSeq + 1, issuedAt: now, tier: "" },
    key: d.keys.request, plaintext: utf8(JSON.stringify({ v: 1, requestId, class: "chat.send", text })), signingKey: d.signingPrivate });
  await store.put(`${base(d)}/in/${String(now).padStart(13, "0")}-${requestId}.bin`, utf8(JSON.stringify(env)), 3);
  d.reqSeq += 1;
  d.pending.push({ requestId, issuedAt: now });
  return requestId;
}

/** Design 4.4: out/<requestId>.bin under the current reply key, or the previous one for 24 h after a rotation. */
export async function readReply(store: DeviceStore, d: LinkedDevice, requestId: string, now: number): Promise<Reply | null> {
  const bytes = await store.get(`${base(d)}/out/${requestId}.bin`);
  if (!bytes) return null;
  const env = json(bytes, "bad_envelope") as SyncEnvelope;
  const prev = d.prevReply && now < d.prevReply.until ? d.prevReply : null;
  const key = env?.epoch === d.epoch ? d.keys.reply : prev && env?.epoch === prev.epoch ? prev.key : fail("bad_epoch");
  const r = json(await open({ env, key, verifyKey: await verifyKeyOf(d), expect: { purpose: "reply", userId: d.userId, desktopId: d.sid, from: d.sid, to: d.deviceId, session: "", tier: "" } }), "bad_reply");
  const ok = r?.ok === true
    ? exactKeys(r, ["v", "requestId", "ok", "text", "finishedAt"]) && typeof r.text === "string" && r.text.length <= 100_000 && safeInt(r.finishedAt)
    : r?.ok === false && exactKeys(r, ["v", "requestId", "ok", "code"]) && (REPLY_CODES as readonly string[]).includes(r.code);
  if (!ok || r.v !== 1 || r.requestId !== requestId) fail("bad_reply");
  d.pending = d.pending.filter((p) => p.requestId !== requestId);
  return r as Reply;
}
