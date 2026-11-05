// WebCrypto side of schema/relay/v1 for a linked device. Keys are imported non-extractable; raw subkey bytes from a
// wrap are zeroed after import. Verify first, then decrypt (relay design 4.2/4.4).
import { b64u, concat, context, decodeEnc, enc, headerFields, headerOf, pad, unb64u, unpad, utf8, type Envelope, type Header } from "./wire.ts";

// TypeScript 5.7 narrows BufferSource to ArrayBuffer-backed views; WebCrypto accepts any Uint8Array at runtime.
const subtle: any = globalThis.crypto.subtle;
const ECDSA = { name: "ECDSA", hash: "SHA-256" } as const;

export class RelayCryptoError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "RelayCryptoError"; }
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts)));
}
export const importVerifyKey = (spki: Uint8Array) => subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
export const importAesKey = (raw: Uint8Array, usage: "encrypt" | "decrypt") => subtle.importKey("raw", raw, "AES-GCM", false, [usage]);

const extraOf = (e: Envelope) => (e.eph ? unb64u(e.eph) : new Uint8Array(0));

export async function seal(header: Header, key: CryptoKey, plaintext: Uint8Array, signingKey: CryptoKey,
  nonce: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(12))): Promise<Envelope> {
  const fields = headerFields(header); const extra = new Uint8Array(0);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc([...fields, extra]), tagLength: 128 }, key, pad(plaintext)));
  const sig = new Uint8Array(await subtle.sign(ECDSA, signingKey, concat(context(header.purpose), enc([...fields, extra, nonce, ct]))));
  return { v: 1, ...headerOf(header as Envelope), nonce: b64u(nonce), ct: b64u(ct), sig: b64u(sig) };
}

export async function open(env: Envelope, key: CryptoKey, verifyKey: CryptoKey, expect: Partial<Header>): Promise<Uint8Array> {
  if (env.v !== 1) throw new RelayCryptoError("bad_version");
  const header = headerOf(env);
  for (const [k, v] of Object.entries(expect)) if ((header as unknown as Record<string, unknown>)[k] !== v) throw new RelayCryptoError(`bad_${k}`);
  const fields = headerFields(header); const extra = extraOf(env);
  const nonce = unb64u(env.nonce); const ct = unb64u(env.ct);
  if (nonce.length !== 12 || ct.length < 1040) throw new RelayCryptoError("bad_ciphertext");
  const ok = await subtle.verify(ECDSA, verifyKey, unb64u(env.sig), concat(context(header.purpose), enc([...fields, extra, nonce, ct])));
  if (!ok) throw new RelayCryptoError("bad_signature");
  let pt: ArrayBuffer;
  try { pt = await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: enc([...fields, extra]), tagLength: 128 }, key, ct); }
  catch { throw new RelayCryptoError("bad_ciphertext"); }
  try { return unpad(new Uint8Array(pt)); } catch { throw new RelayCryptoError("bad_padding"); }
}

export interface UnwrapOptions {
  deviceId: string; ecdhPrivate: CryptoKey; ecdhSpki: Uint8Array;
  desktopVerify: CryptoKey; desktopSigningSpki: Uint8Array; currentEpoch: number;
}

export async function unwrap(env: Envelope, o: UnwrapOptions) {
  if (env.purpose !== "wrap" || !env.eph) throw new RelayCryptoError("bad_purpose");
  if (env.to !== o.deviceId) throw new RelayCryptoError("bad_to");
  if (!(env.epoch > o.currentEpoch)) throw new RelayCryptoError("stale_epoch");
  const eph = unb64u(env.eph);
  const ephKey = await subtle.importKey("spki", eph, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const z = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: ephKey }, o.ecdhPrivate, 256));
  const hk = await subtle.importKey("raw", z, "HKDF", false, ["deriveBits"]);
  const info = enc(["llmide/wrap/v1", env.epoch, o.deviceId, await sha256(o.ecdhSpki), await sha256(o.desktopSigningSpki), env.tier]);
  const raw = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: await sha256(enc([eph, o.ecdhSpki])), info }, hk, 256));
  z.fill(0);
  const wrapKey = await importAesKey(raw, "decrypt"); raw.fill(0);
  const bundle = await open(env, wrapKey, o.desktopVerify, { purpose: "wrap" });
  const [req, rep, token] = decodeEnc(bundle, 3);
  if (req.length !== 32 || rep.length !== 32) throw new RelayCryptoError("bad_wrap");
  const request = await importAesKey(req, "encrypt");
  const reply = await importAesKey(rep, "decrypt");
  req.fill(0); rep.fill(0);
  return { request, reply, hostApiToken: new TextDecoder().decode(token), sig: unb64u(env.sig) };
}

export const keyConfirmPlaintext = (wrapSig: Uint8Array) => sha256(utf8("llmide/keyconfirm/v1"), wrapSig);

export async function authProof(signingKey: CryptoKey, challenge: string, role: "device", tokenHashHex: string): Promise<string> {
  return b64u(new Uint8Array(await subtle.sign(ECDSA, signingKey, utf8(`llmide/relay/auth/v1\n${challenge}\n${role}\n${tokenHashHex}`))));
}
