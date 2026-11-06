// Sync v1 enrollment, device side (schema/sync/v1/README.md "Enrollment"; SP2 extension/core/sync-enroll.mjs is the
// desktop twin). The enrollment secret es is turned into non-extractable keys at once and its bytes are zeroed; the
// SAS is computed only from values this device holds or that the desktop committed before it revealed nD.
import { b64u, enc, unb64u, utf8 } from "./wire.ts";
import { decodeEnc, fail, importVerify, open, seal, sha256, type SyncEnvelope } from "./envelope.ts";

const subtle: any = globalThis.crypto.subtle;
export const ID22 = /^[A-Za-z0-9_-]{22}$/;
export const NAME_MAX = 64;
const FP43 = /^[A-Za-z0-9_-]{43}$/;
const ST_RE = /^((mega|box):[A-Za-z0-9_.-]{1,64}|sftp:(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|memory:)$/; // memory: is the test adapter only; the controller refuses it
const BOX_APP_RE = /^[A-Za-z0-9]{16,128}$/;
const USER_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PAIR_FIELDS = ["sid", "sfp", "dir", "slot", "es", "st"] as const;
export type Tier = "web" | "ios";
export interface Pair { sid: string; sfp: string; dir: string; slot: string; es: string; st: string; bi?: string; bs?: string }
export interface Claim { deviceId: string; ecdhSpki: Uint8Array; signingSpki: Uint8Array; name: string }
export interface EnrollKeys { enroll: CryptoKey; enrollack: CryptoKey; bind: CryptoKey; sas: CryptoKey }
type Bound = Pick<Pair, "sid" | "slot" | "dir" | "sfp"> & Claim & { tier: Tier };

export const newId22 = () => b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));

export function parsePair(url: unknown): Pair {
  if (typeof url !== "string") fail("bad_pair");
  const u = url as string;
  let q = "";
  if (u.startsWith("llmide://pair?")) q = u.slice("llmide://pair?".length);
  else {
    const i = u.indexOf("#pair=");
    if (i < 0) fail("bad_pair");
    try { q = decodeURIComponent(u.slice(i + "#pair=".length)); } catch { fail("bad_pair"); }
  }
  const s = new URLSearchParams(q);
  if (s.get("sv") !== "1") fail("bad_pair");
  const p = Object.fromEntries(PAIR_FIELDS.map((k) => [k, s.get(k) ?? ""])) as unknown as Pair;
  if (![p.sid, p.dir, p.slot, p.es].every((v) => ID22.test(v)) || !FP43.test(p.sfp) || !ST_RE.test(p.st)) fail("bad_pair");
  if (p.st.startsWith("box:")) {
    p.bi = s.get("bi") ?? ""; p.bs = s.get("bs") ?? "";
    if (!BOX_APP_RE.test(p.bi) || !BOX_APP_RE.test(p.bs)) fail("bad_pair");
  }
  return p;
}

export async function enrollKeys(es: Uint8Array, sid: string, slot: string): Promise<EnrollKeys> {
  if (es.length !== 16) fail("bad_secret");
  const hk = await subtle.importKey("raw", es, "HKDF", false, ["deriveBits"]);
  const salt = await sha256(utf8("llmide-sync-enroll-v1"));
  const raw = async (label: string) => new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc([label, sid, slot]) }, hk, 256));
  const make = async (label: string, alg: unknown, usage: string): Promise<CryptoKey> => {
    const r = await raw(label);
    try { return await subtle.importKey("raw", r, alg, false, [usage]); } finally { r.fill(0); }
  };
  const hmac = { name: "HMAC", hash: "SHA-256" };
  return { enroll: await make("enroll", "AES-GCM", "encrypt"), enrollack: await make("enrollack", "AES-GCM", "decrypt"),
    bind: await make("bind", hmac, "sign"), sas: await make("sas", hmac, "sign") };
}

export const deviceIdOf = async (signingSpki: Uint8Array) => b64u((await sha256(signingSpki)).subarray(0, 16));

/** A canonical P-256 SPKI (re-export gives the same bytes), returned as a non-extractable verify key. The temporary
 *  import is extractable only to compare bytes; it is a public key. */
export async function p256Spki(bytes: Uint8Array): Promise<CryptoKey> {
  let k: CryptoKey;
  try { k = await subtle.importKey("spki", bytes, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]); } catch { return fail("bad_key"); }
  const again = new Uint8Array(await subtle.exportKey("spki", k));
  if (again.length !== bytes.length || again.some((x, i) => x !== bytes[i])) fail("bad_key");
  return importVerify(bytes);
}

export const validName = (n: unknown): n is string =>
  typeof n === "string" && n.length >= 1 && n.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(n);
const checkTier = (t: unknown) => { if (t !== "web" && t !== "ios") fail("bad_tier"); };
const bound = (f: Bound) => [f.sid, f.slot, f.dir, unb64u(f.sfp), f.tier, f.deviceId, f.ecdhSpki, f.signingSpki, f.name];
const equal = (a: Uint8Array, b: Uint8Array) => { let d = a.length ^ b.length; for (let i = 0; i < Math.min(a.length, b.length); i++) d |= a[i] ^ b[i]; return d === 0; };

export const claimMac = async (bind: CryptoKey, f: Bound) => new Uint8Array(await subtle.sign("HMAC", bind, enc(bound(f))));
export const claimHash = (c: Claim) => sha256(enc(["llmide/sync-claim/v1", c.deviceId, c.ecdhSpki, c.signingSpki, c.name]));
export async function sasCode(sasKey: CryptoKey, f: Bound & { nD: Uint8Array }): Promise<string> {
  const h = new Uint8Array(await subtle.sign("HMAC", sasKey, enc([...bound(f), f.nD])));
  return String(new DataView(h.buffer).getUint32(0) % 1_000_000).padStart(6, "0");
}

/** Contract 4c: the claim for e/<slot>/<Id22>.bin; extra = the signing SPKI so the desktop verifies before decrypting. */
export async function sealClaim(o: { pair: Pair; tier: Tier; name: string; ecdhSpki: Uint8Array; signingSpki: Uint8Array; signingKey: CryptoKey;
  issuedAt: number; keys: EnrollKeys; nonce?: Uint8Array }): Promise<SyncEnvelope> {
  checkTier(o.tier);
  if (!validName(o.name)) fail("bad_name");
  const deviceId = await deviceIdOf(o.signingSpki);
  const mac = await claimMac(o.keys.bind, { ...o.pair, tier: o.tier, deviceId, ecdhSpki: o.ecdhSpki, signingSpki: o.signingSpki, name: o.name });
  return seal({ header: { purpose: "enroll", userId: "", desktopId: o.pair.sid, from: deviceId, to: o.pair.sid, epoch: 0, session: o.pair.slot, seq: 0, issuedAt: o.issuedAt, tier: "" },
    key: o.keys.enroll, plaintext: enc([o.ecdhSpki, o.signingSpki, o.name, mac]), signingKey: o.signingKey, extra: o.signingSpki, nonce: o.nonce });
}

/** Contract 4d: verify the ack with the key pinned by sfp; refuse an ack bound to anyone else's claim. */
export async function openAck(o: { env: unknown; pair: Pair; tier: Tier; claim: Claim; keys: EnrollKeys; desktopVerifyKey: CryptoKey }): Promise<{ userId: string; nD: Uint8Array }> {
  checkTier(o.tier);
  const pt = await open({ env: o.env, key: o.keys.enrollack, verifyKey: o.desktopVerifyKey,
    expect: { purpose: "enrollack", desktopId: o.pair.sid, from: o.pair.sid, to: o.claim.deviceId, epoch: 0, session: o.pair.slot, tier: o.tier } });
  const [nD, hash] = decodeEnc(pt, 2);
  if (nD.length !== 16 || hash.length !== 32) fail("bad_ack");
  if (!equal(hash, await claimHash(o.claim))) fail("ack_mismatch");
  const userId = (o.env as SyncEnvelope).userId;
  if (typeof userId !== "string" || !USER_RE.test(userId)) fail("bad_userId");
  return { userId, nD: new Uint8Array(nD) };
}
