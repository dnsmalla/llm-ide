// Byte-exact text helpers for the bus caps. `String.length` counts UTF-16 units, so a cap written in `.length` lets
// three-byte (CJK) or four-byte (emoji) text through at 3 to 4 times the stated size. Everything here counts UTF-8 bytes
// and never splits a character.

/** The longest prefix of `s` that is at most `maxBytes` bytes of UTF-8 (whole characters only). */
export function truncateUtf8(s, maxBytes) {
  const str = String(s ?? '');
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let end = Math.min(str.length, maxBytes); // a character is at least 1 byte, so the answer is no longer than maxBytes units
  while (end > 0 && Buffer.byteLength(str.slice(0, end), 'utf8') > maxBytes) end -= Math.max(1, Math.ceil((Buffer.byteLength(str.slice(0, end), 'utf8') - maxBytes) / 4));
  end = Math.max(0, end);
  // never end in the middle of a surrogate pair
  const last = str.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

/** Splits `s` into pieces of at most `chunkBytes` UTF-8 bytes (whole characters), at most `maxChunks` pieces. */
export function chunkUtf8(s, chunkBytes, maxChunks = Infinity) {
  const out = [];
  let rest = String(s ?? '');
  while (rest.length && out.length < maxChunks) {
    const piece = truncateUtf8(rest, chunkBytes);
    if (!piece.length) break; // a single character larger than chunkBytes cannot be emitted
    out.push(piece);
    rest = rest.slice(piece.length);
  }
  return out;
}
