// Untrusted text (project names, recent paths, host reasons) is always rendered as text; this strips what
// could disguise it first: control characters, bidirectional overrides and isolates, zero-width and BOM
// characters. Then it is length-capped by code point. Pure.

// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** `raw` as safe single-line display text of at most `max` code points (an ellipsis marks a cut). */
export function safeText(raw: unknown, max = 200): string {
  if (typeof raw !== "string") return "";
  const s = raw.replace(/[\t\n\r\v\f\u0085\u2028\u2029]+/g, " ").replace(STRIP, "").replace(/\s+/g, " ").trim();
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, Math.max(1, max - 1)).join("")}…`;
}
