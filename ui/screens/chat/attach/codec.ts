// Pure byte/text helpers for attachments: image sniffing, UTF-8 decoding of a possibly cut chunk, base64.
import { IMAGE_MIMES } from "./limits";

/** The image type by magic bytes, or null. The extension-based mime from the host is only a hint. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export const isSupportedImageMime = (m: string): boolean => IMAGE_MIMES.has(m);

export type TextDecode = { ok: true; text: string; cutMidCharacter: boolean } | { ok: false; reason: "binary" | "not_utf8" };

/**
 * Decodes the head of a file as UTF-8 text. A NUL byte means binary. `mayBeCut` says the bytes are only the start of a
 * longer file: an incomplete multi-byte sequence at the very end is then dropped instead of failing the decode.
 * A UTF-8 BOM is removed. UTF-16 and other encodings are refused (the core takes UTF-8 text).
 */
export function decodeText(bytes: Uint8Array, mayBeCut: boolean): TextDecode {
  const scan = Math.min(bytes.length, 8192);
  for (let i = 0; i < scan; i++) if (bytes[i] === 0) return { ok: false, reason: "binary" };
  let end = bytes.length;
  let cut = false;
  if (mayBeCut) {
    // Back up over an incomplete trailing sequence (at most 3 continuation bytes + 1 lead byte).
    let i = end - 1, back = 0;
    while (i >= 0 && back < 4 && (bytes[i] & 0xc0) === 0x80) { i--; back++; }
    if (i >= 0) {
      const lead = bytes[i];
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (need > 1 && back + 1 < need) { end = i; cut = true; }
    }
  }
  try {
    let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.includes("\u0000")) return { ok: false, reason: "binary" };
    return { ok: true, text, cutMidCharacter: cut };
  } catch {
    return { ok: false, reason: "not_utf8" };
  }
}

/** Standard base64 of bytes, built in 3-byte-aligned slices so a 4.5 MB image never overflows the call stack. */
export function toBase64(bytes: Uint8Array): string {
  const SLICE = 3 * 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += SLICE) {
    let s = "";
    const end = Math.min(bytes.length, i + SLICE);
    for (let j = i; j < end; j++) s += String.fromCharCode(bytes[j]);
    parts.push(btoa(s));
  }
  return parts.join("");
}

/** The `content` of an image attachment on the wire: a `[binary:<mime>]` line, then the base64 data. */
export const imageContent = (mime: string, bytes: Uint8Array): string => `[binary:${mime}]\n${toBase64(bytes)}`;

/** Display name: base name only, controls/bidi removed, capped. Never a path. */
export function safeFileName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const base = s.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F\uFEFF]/g, "").trim();
  const capped = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
  return capped || "file";
}
