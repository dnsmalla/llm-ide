// Sync v1 envelope (schema/sync/v1) in WebCrypto for a device: relay v1 bytes plus the sync purposes. A port of
// extension/core/sync-envelope.mjs with the same error codes, checked against schema/sync/v1/vectors/v1.json.
// Verify before decrypt; unknown fields, purposes and versions fail closed. Every key is a non-extractable CryptoKey.
import { b64u, concat, decodeEnc as rawDecodeEnc, enc, pad, unb64u, unpad, utf8 } from "./wire.ts";

// TypeScript narrows BufferSource to ArrayBuffer-backed views; WebCrypto accepts any Uint8Array at runtime.
const subtle: any = globalThis.crypto.subtle;
const ECDSA = { name: "ECDSA", hash: "SHA-256" } as const;
export const PURPOSES = ["request", "reply", "snapshot", "manifest", "syncwrap", "enroll", "enrollack"] as const;
export type SyncPurpose = (typeof PURPOSES)[number];
export interface SyncHeader {
  purpose: SyncPurpose; userId: string; desktopId: string; from: string; to: string;
  epoch: number; session: string; seq: number; issuedAt: number; tier: "" | "web" | "ios";
}
export interface SyncEnvelope extends SyncHeader { v: 1; nonce: string; ct: string; sig: string; eph?: string }
export interface WrapKeys { request: CryptoKey; reply: CryptoKey; snapshot: CryptoKey; manifest: CryptoKey }
const ID_KEYS = ["purpose", "userId", "desktopId", "from", "to", "epoch", "session", "seq", "issuedAt", "tier"] as const;
const ENV_KEYS = new Set<string>(["v", ...ID_KEYS, "nonce", "ct", "sig", "eph"]);

export class SyncCryptoError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "SyncCryptoError"; }
}
export const fail = (code: string): never => { throw new SyncCryptoError(code); };
/** wire.ts throws plain Errors whose message is the code (bad_encoding, bad_padding, bad_base64, frame_too_large…). */
function coded<T>(f: () => T): T {
  try { return f(); } catch (e) {
    if (e instanceof SyncCryptoError) throw e;
    const m = e instanceof Error ? e.message : "";
    throw new SyncCryptoError(/^[a-z_]+$/.test(m) ? m : "bad_encoding");
  }
}
export const decodeEnc = (b: Uint8Array, count: number) => coded(() => rawDecodeEnc(b, count));
const b64 = (s: unknown): Uint8Array => (typeof s === "string" ? coded(() => unb64u(s)) : fail("bad_base64"));
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const context = (p: string) => utf8(`llmide/${p}/v1\0`);
const headerFields = (h: SyncHeader) => [1, h.purpose, h.userId, h.desktopId, h.from, h.to, h.epoch, h.session, h.seq, h.issuedAt, h.tier];
const headerOf = (e: SyncHeader): SyncHeader => Object.fromEntries(ID_KEYS.map((k) => [k, e[k]])) as unknown as SyncHeader;

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts)));
}
export const importAes = (raw: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> => subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
export const importVerify = (spki: Uint8Array): Promise<CryptoKey> => subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

export async function seal(o: { header: SyncHeader; key: CryptoKey; plaintext: Uint8Array; signingKey: CryptoKey; nonce?: Uint8Array; extra?: Uint8Array }): Promise<SyncEnvelope> {
  if (!PURPOSES.includes(o.header.purpose)) fail("bad_purpose");
  const nonce = o.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
  const extra = o.extra ?? new Uint8Array(0);
  const fields = headerFields(o.header);
  const body = coded(() => pad(o.plaintext));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: coded(() => enc([...fields, extra])), tagLength: 128 }, o.key, body));
  const sig = new Uint8Array(await subtle.sign(ECDSA, o.signingKey, concat(context(o.header.purpose), coded(() => enc([...fields, extra, nonce, ct])))));
  return { v: 1, ...headerOf(o.header), nonce: b64u(nonce), ct: b64u(ct), sig: b64u(sig), ...(extra.length ? { eph: b64u(extra) } : {}) };
}

export async function open(o: { env: unknown; key: CryptoKey; verifyKey: CryptoKey; expect?: Partial<SyncHeader> }): Promise<Uint8Array> {
  const env = o.env as SyncEnvelope;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).some((k) => !ENV_KEYS.has(k))) fail("bad_envelope");
  if (env.v !== 1) fail("bad_version");
  if (!PURPOSES.includes(env.purpose)) fail("bad_purpose");
  const header = headerOf(env);
  for (const [k, v] of Object.entries(o.expect ?? {})) if ((header as unknown as Record<string, unknown>)[k] !== v) fail(`bad_${k}`);
  const extra = env.eph ? b64(env.eph) : new Uint8Array(0);
  const nonce = b64(env.nonce); const ct = b64(env.ct);
  if (nonce.length !== 12 || ct.length < 16 + 1024) fail("bad_ciphertext");
  const fields = headerFields(header);
  let ok = false;
  try { ok = await subtle.verify(ECDSA, o.verifyKey, b64(env.sig), concat(context(env.purpose), enc([...fields, extra, nonce, ct]))); } catch { ok = false; }
  if (!ok) fail("bad_signature");
  let pt: ArrayBuffer;
  try { pt = await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: enc([...fields, extra]), tagLength: 128 }, o.key, ct); }
  catch { return fail("bad_ciphertext"); }
  return coded(() => unpad(new Uint8Array(pt)));
}

/** Device side of the syncwrap (design 5.2 step 5): ECDH by deriveBits, HKDF, verify with the pinned key, then import. */
export async function unwrapSync(o: { env: SyncEnvelope; ecdhPrivate: CryptoKey; deviceEcdhSpki: Uint8Array; desktopSigningSpki: Uint8Array;
  verifyKey: CryptoKey; currentEpoch: number; deviceId: string }): Promise<WrapKeys> {
  const env = o.env;
  if (env?.purpose !== "syncwrap" || !env.eph) fail("bad_purpose");
  if (env.to !== o.deviceId) fail("bad_to");
  if (!(env.epoch > o.currentEpoch)) fail("stale_epoch");
  const ephSpki = b64(env.eph);
  let ephKey: CryptoKey;
  try { ephKey = await subtle.importKey("spki", ephSpki, { name: "ECDH", namedCurve: "P-256" }, false, []); } catch { return fail("bad_key"); }
  const z = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: ephKey }, o.ecdhPrivate, 256));
  const hk = await subtle.importKey("raw", z, "HKDF", false, ["deriveBits"]);
  z.fill(0);
  const [devHash, deskHash] = [await sha256(o.deviceEcdhSpki), await sha256(o.desktopSigningSpki)];
  const info = coded(() => enc(["llmide/syncwrap/v1", env.epoch, o.deviceId, devHash, deskHash, env.tier]));
  const raw = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: await sha256(enc([ephSpki, o.deviceEcdhSpki])), info }, hk, 256));
  const wrapKey = await importAes(raw, "decrypt");
  raw.fill(0);
  const parts = decodeEnc(await open({ env, key: wrapKey, verifyKey: o.verifyKey, expect: { purpose: "syncwrap" } }), 4);
  if (parts.some((p) => p.length !== 32)) fail("bad_wrap");
  const [rq, rp, sn, mf] = parts;
  const out = { request: await importAes(rq, "encrypt"), reply: await importAes(rp, "decrypt"), snapshot: await importAes(sn, "decrypt"), manifest: await importAes(mf, "decrypt") };
  for (const p of parts) p.fill(0);
  return out;
}
