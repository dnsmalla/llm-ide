// ALL_ENDPOINTS roster parser, shared by scripts/http-inventory.mjs and
// scripts/conformance-http.mjs so the roster is read in exactly one way.
//
// Parses the array from source text: the server is never imported, because
// importing extension/server.mjs boots it.

/** 1-based line number of `index` in `text`. */
export function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Every `'/path'` literal inside `const ALL_ENDPOINTS = [ … ];`.
 *
 * @param {string} src        text of the file that declares the roster
 * @param {string} sourceRel  repo-relative path, used only in the error message
 * @returns {{ path: string, line: number }[]} in source order, duplicates kept
 */
export function parseRoster(src, sourceRel = 'extension/server.mjs') {
  const m = /const ALL_ENDPOINTS = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error(`ALL_ENDPOINTS array not found in ${sourceRel}`);
  const base = m.index + m[0].indexOf('[') + 1;
  return [...m[1].matchAll(/'(\/[^']*)'/g)].map((x) => ({
    path: x[1],
    line: lineOf(src, base + x.index),
  }));
}
