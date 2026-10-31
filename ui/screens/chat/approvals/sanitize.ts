// Untrusted text hygiene for approval cards. Tool arguments and model text decide what the user allows, so
// anything that can hide or reorder text is made visible, and anything large is cut. Pure.

/**
 * Characters that hide, reorder or spoof text: C0/C1 controls (except \n and \t), no-break and every fixed-width space
 * (U+00A0, U+1680, U+2000-200A, U+202F, U+205F, U+3000: they look like a space but are not one, so `rm\u00A0-rf` reads as
 * two words), soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul/braille blanks, Mongolian vowel
 * separator, zero-width and bidi controls, line/paragraph separators, invisible math operators, BOM, interlinear
 * annotation marks, variation selectors (U+FE00-FE0F, U+E0100-E01EF) and the Unicode tag block (U+E0000-E007F, which
 * can carry an invisible instruction to the model).
 */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u00A0\u00AD\u034F\u061C\u115F\u1160\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export interface Sanitized {
  text: string;
  /** Hidden or control characters were present (shown as `<U+XXXX>`). */
  hadHidden: boolean;
  /** How many hidden or control characters were escaped. */
  hiddenCount: number;
  /** Text was cut at the cap. */
  truncated: boolean;
  /** Length before the cut, in UTF-16 units. */
  totalChars: number;
}

const escapeChar = (c: string) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;

/** Cuts at `cap` UTF-16 units without splitting a surrogate pair. */
export function clip(text: string, cap: number): { text: string; clipped: boolean } {
  if (text.length <= cap) return { text, clipped: false };
  let end = cap;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return { text: text.slice(0, end), clipped: true };
}

/** Escapes hidden characters, normalises line ends, cuts at `cap`. Never returns markup: callers render it as text. */
export function sanitizeText(input: unknown, cap: number): Sanitized {
  const raw = typeof input === "string" ? input : input === null || input === undefined ? "" : String(input);
  const cut = clip(raw, cap);
  let hiddenCount = 0;
  const text = cut.text.replace(/\r\n?/g, "\n").replace(HIDDEN, (c) => { hiddenCount++; return escapeChar(c); });
  return { text, hadHidden: hiddenCount > 0, hiddenCount, truncated: cut.clipped, totalChars: raw.length };
}

/** True when the text carries hidden or control characters (without allocating the escaped copy). */
export function hasHidden(text: string): boolean {
  HIDDEN.lastIndex = 0;
  return HIDDEN.test(text.replace(/\r\n?/g, "\n"));
}

/** First `n` lines and whether more exist (lazy rendering of long blobs). */
export function firstLines(text: string, n: number): { text: string; more: boolean; total: number } {
  let idx = -1, count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { count++; if (count === n && idx === -1) idx = i; }
  }
  const total = count + (text.length > 0 && text.charCodeAt(text.length - 1) !== 10 ? 1 : 0);
  if (idx === -1) return { text, more: false, total };
  return { text: text.slice(0, idx), more: true, total };
}
