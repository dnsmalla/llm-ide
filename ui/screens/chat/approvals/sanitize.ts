// Untrusted text hygiene for approval cards. Tool arguments and model text decide what the user allows, so
// anything that can hide or reorder text is made visible, and anything large is cut. Pure.

/**
 * Characters that hide, reorder or spoof text: C0/C1 controls (except \n and \t), soft hyphen, Arabic letter mark,
 * Hangul/braille blanks, zero-width and bidi controls, invisible math operators, BOM, interlinear annotation marks.
 */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/gu;

export interface Sanitized {
  text: string;
  /** Hidden or control characters were present (shown as `<U+XXXX>`). */
  hadHidden: boolean;
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
  let hadHidden = false;
  const text = cut.text.replace(/\r\n?/g, "\n").replace(HIDDEN, (c) => { hadHidden = true; return escapeChar(c); });
  return { text, hadHidden, truncated: cut.clipped, totalChars: raw.length };
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
