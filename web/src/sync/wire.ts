// Byte primitives of the relay v1 envelope format (schema/relay/v1) that sync v1 builds on (schema/sync/v1):
// canonical encoding, padding buckets, base64url. Pure, DOM-free. Moved from the former relay directory when the relay
// client was removed (ADR 0020); the bytes are unchanged and checked against the relay v1 vectors.
const BUCKETS = [1024, 4096, 16384, 65536, 262144, 1048576] as const;
export const MAX_FRAME = 1048576 - 4;
const te = new TextEncoder();

export const utf8 = (s: string): Uint8Array => te.encode(s);

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
