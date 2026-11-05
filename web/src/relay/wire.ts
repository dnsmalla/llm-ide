// schema/relay/v1 wire primitives: canonical encoding, padding, base64url. Pure, DOM-free.
export type Purpose = "open" | "opened" | "request" | "reply" | "wrap" | "keyconfirm";
export interface Header {
  purpose: Purpose; userId: string; desktopId: string; from: string; to: string;
  epoch: number; session: string; seq: number; issuedAt: number; tier: "" | "web" | "ios";
}
export interface Envelope extends Header { v: 1; nonce: string; ct: string; sig: string; eph?: string }

export const BUCKETS = [1024, 4096, 16384, 65536, 262144, 1048576] as const;
export const MAX_FRAME = 1048576 - 4;
export const KEY_MESSAGE_CAP = 2 ** 24;
const HEADER_KEYS = ["purpose", "userId", "desktopId", "from", "to", "epoch", "session", "seq", "issuedAt", "tier"] as const;
const te = new TextEncoder();

export const utf8 = (s: string): Uint8Array => te.encode(s);
export const context = (p: Purpose): Uint8Array => utf8(`llmide/${p}/v1\0`);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function enc(fields: ReadonlyArray<number | string | Uint8Array>): Uint8Array {
  return concat(...fields.flatMap((f) => {
    let v: Uint8Array;
    if (typeof f === "number") {
      if (!Number.isSafeInteger(f) || f < 0) throw new Error("bad_integer");
      v = new Uint8Array(8); new DataView(v.buffer).setBigUint64(0, BigInt(f));
    } else v = typeof f === "string" ? utf8(f) : f;
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, v.length);
    return [len, v];
  }));
}

export function decodeEnc(b: Uint8Array, count: number): Uint8Array[] {
  const out: Uint8Array[] = []; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); let off = 0;
  while (off < b.length) {
    if (off + 4 > b.length) throw new Error("bad_encoding");
    const n = dv.getUint32(off); off += 4;
    if (off + n > b.length) throw new Error("bad_encoding");
    out.push(b.subarray(off, off + n)); off += n;
  }
  if (out.length !== count) throw new Error("bad_encoding");
  return out;
}

export const headerFields = (h: Header) => [1, h.purpose, h.userId, h.desktopId, h.from, h.to, h.epoch, h.session, h.seq, h.issuedAt, h.tier];
export const headerOf = (e: Envelope): Header => Object.fromEntries(HEADER_KEYS.map((k) => [k, e[k]])) as unknown as Header;

export function pad(b: Uint8Array): Uint8Array {
  if (b.length > MAX_FRAME) throw new Error("frame_too_large");
  const out = new Uint8Array(BUCKETS.find((s) => s >= b.length + 4)!);
  new DataView(out.buffer).setUint32(0, b.length); out.set(b, 4);
  return out;
}

export function unpad(b: Uint8Array): Uint8Array {
  if (!(BUCKETS as readonly number[]).includes(b.length)) throw new Error("bad_padding");
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  if (n > b.length - 4) throw new Error("bad_padding");
  for (let i = 4 + n; i < b.length; i++) if (b[i] !== 0) throw new Error("bad_padding");
  return b.subarray(4, 4 + n);
}

export function b64u(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad_base64");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
