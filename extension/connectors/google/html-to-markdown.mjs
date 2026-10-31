// HTML to Markdown for untrusted third-party content (mail bodies, event descriptions). Plan section 4 item 9.
//
// A real tokenizer (not the regex stripHtml of email-source.mjs): it walks the input once, never builds a DOM and
// never emits raw HTML. Everything that comes out is text plus a small fixed set of Markdown constructs:
//   - script, style, iframe, object, embed, form, head, svg, math, template, noscript and comments: dropped with content;
//   - event attributes and every attribute not listed below are never read;
//   - images are NEVER emitted as images: `[image omitted]` (alt text kept, 1x1 tracking pixels dropped), src is discarded;
//   - links keep only http, https and mailto URLs (javascript:, data:, vbscript: and the like are dropped, the text stays);
//     the URL is written as text for a human to read, nothing is fetched or followed by the core;
//   - text is escaped so a body cannot smuggle Markdown or HTML back in (`![x](url)` becomes `!\[x\]\(url)` text,
//     `<img ...>` becomes `\<img ...>`), because the viewer that renders the note must not load a remote image either.
// Output is capped; a marker says so.

const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'head', 'svg', 'math', 'template', 'noscript', 'title', 'textarea', 'select', 'button', 'applet', 'frameset', 'frame', 'audio', 'video', 'canvas']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'iframe']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'address', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'center', 'details', 'summary', 'fieldset']);
const MAX_DEPTH = 200;

// Character classes are built from code points so the source holds no invisible or control characters.
function rangeClass(ranges) {
  return new RegExp(`[${ranges.map(([a, b]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`)).join('')}]`, 'g');
}
const WS_ALL = new RegExp(`[${' \\t\\r\\n\\f\\v'}${String.fromCodePoint(0xa0)}${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}]+`, 'g');
const WS_RUN = new RegExp(`[${' \\t\\r\\n\\f'}${String.fromCodePoint(0xa0)}]+`, 'g');

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '(c)', reg: '(R)', trade: '(TM)', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', laquo: '«', raquo: '»',
  times: '×', deg: '°', zwnj: '', zwj: '', shy: '',
};

// Invisible padding that marketing mail uses (zero-width, bidi, soft hyphen, BOM) is removed.
const INVISIBLE = rangeClass([[0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0]]);

const CONTROL = rangeClass([[0, 8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f]]);

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10});?/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0x7f && cp <= 0x9f)) return '';
      return String.fromCodePoint(cp);
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Neutralise Markdown/HTML syntax in untrusted TEXT (not in the constructs this module writes itself). */
export function escapeMarkdownText(s) {
  // `_` between two word characters is not emphasis in CommonMark and is left alone: escaping it would also break the
  // secret patterns (ghp_..., sk-ant_...) that the redactor matches on this very text.
  return String(s)
    .replace(/[\\`*[\]<>|]/g, (c) => `\\${c}`)
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_')
    .replace(/^(\s*)([#>+-]|\d+[.)])(\s)/gm, '$1\\$2$3')
    .replace(/^(\s*)(={3,}|-{3,})\s*$/gm, '$1\\$2');
}

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
/** A URL fit to show as text and as a Markdown link target, or null. Never fetched by the core. */
export function safeLinkUrl(raw) {
  let v = decodeEntities(String(raw ?? '')).replace(CONTROL, '').replace(INVISIBLE, '').replace(WS_ALL, '').trim();
  if (!v || v.length > 2000) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (!SAFE_SCHEMES.has(u.protocol)) return null;
  if (u.username || u.password) return null;
  v = u.toString();
  return v.replace(/[()<>`\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseTag(src, i) {
  // src[i] === '<'; returns { name, closing, attrs, end, selfClose } or null when this is not a tag
  let j = i + 1;
  let closing = false;
  if (src[j] === '/') { closing = true; j++; }
  const m = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(src.slice(j, j + 40));
  if (!m) return null;
  const name = m[0].toLowerCase();
  j += m[0].length;
  const attrs = {};
  let selfClose = false;
  const n = src.length;
  for (;;) {
    while (j < n && /[\s/]/.test(src[j])) { if (src[j] === '/' && src[j + 1] === '>') selfClose = true; j++; }
    if (j >= n) return { name, closing, attrs, end: n, selfClose };
    if (src[j] === '>') return { name, closing, attrs, end: j + 1, selfClose };
    const am = /^[^\s=/>"']+/.exec(src.slice(j, j + 80));
    if (!am) { j++; continue; }
    const an = am[0].toLowerCase();
    j += am[0].length;
    while (j < n && /\s/.test(src[j])) j++;
    let val = '';
    if (src[j] === '=') {
      j++;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j]; const e = src.indexOf(q, j + 1);
        if (e === -1) { val = src.slice(j + 1, j + 2001); j = n; } else { val = src.slice(j + 1, Math.min(e, j + 2001)); j = e + 1; }
      } else {
        const e = /[\s>]/.exec(src.slice(j, j + 2001));
        const len = e ? e.index : Math.min(2000, n - j);
        val = src.slice(j, j + len); j += len;
      }
    }
    if (an === 'href' || an === 'alt' || an === 'width' || an === 'height') attrs[an] = val; // the only attributes ever read
  }
}

/**
 * @param {string} html untrusted HTML
 * @param {{ maxChars?: number }} [o] output cap (default 200 000)
 * @returns {string} Markdown text
 */
export function htmlToMarkdown(html, { maxChars = 200_000 } = {}) {
  const src = String(html ?? '');
  const n = src.length;
  // Buffers: the top one receives output. Links, blockquotes and list items push their own and compose on close.
  const stack = [{ kind: 'root', out: [] }];
  const top = () => stack[stack.length - 1];
  const lists = []; // { ordered, n }
  let skipDepth = 0; let skipName = '';
  let inPre = 0;
  let i = 0;
  let produced = 0;

  const emit = (s) => { if (!s) return; top().out.push(s); produced += s.length; };
  const text = (raw) => {
    let t = decodeEntities(raw).replace(INVISIBLE, '').replace(CONTROL, '');
    if (!inPre) t = t.replace(WS_RUN, ' ');
    if (!t) return;
    emit(escapeMarkdownText(t));
  };
  const blockBreak = () => { const o = top().out; if (o.length && !/\n\n$/.test(o[o.length - 1])) emit('\n\n'); };
  const lineBreak = () => { const o = top().out; if (o.length && !/\n$/.test(o[o.length - 1])) emit('\n'); };
  const closeBuffer = (kind) => {
    // find nearest buffer of `kind`; fold everything above it into it first
    let idx = -1;
    for (let k = stack.length - 1; k > 0; k--) if (stack[k].kind === kind) { idx = k; break; }
    if (idx === -1) return null;
    while (stack.length - 1 > idx) { const b = stack.pop(); top().out.push(b.out.join('')); }
    return stack.pop();
  };

  while (i < n && produced < maxChars * 3) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { if (!skipDepth) text(src.slice(i)); break; }
    if (lt > i && !skipDepth) text(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e === -1 ? n : e + 3; continue; }
    if (src[i + 1] === '!' || src[i + 1] === '?') { const e = src.indexOf('>', i + 2); i = e === -1 ? n : e + 1; continue; }
    const tag = parseTag(src, i);
    if (!tag) { if (!skipDepth) text('<'); i += 1; continue; }
    i = tag.end;
    const { name, closing } = tag;

    if (skipDepth) {
      if (name === skipName && !VOID.has(name)) { if (closing) skipDepth -= 1; else if (!tag.selfClose) skipDepth += 1; }
      continue;
    }
    if (RAW_TEXT.has(name) && !closing) {
      // content is not markup: skip to the matching end tag (case-insensitive), dropped
      const low = src.slice(i).toLowerCase();
      const e = low.indexOf(`</${name}`);
      if (e === -1) { i = n; } else { const g = src.indexOf('>', i + e); i = g === -1 ? n : g + 1; }
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !tag.selfClose && !VOID.has(name)) { skipDepth = 1; skipName = name; }
      continue;
    }
    if (stack.length > MAX_DEPTH) continue;

    if (name === 'br') { emit('\n'); continue; }
    if (name === 'hr') { blockBreak(); emit('---\n\n'); continue; }
    if (name === 'img') {
      const w = Number.parseInt(tag.attrs.width ?? '', 10); const h = Number.parseInt(tag.attrs.height ?? '', 10);
      if ((Number.isFinite(w) && w <= 2) || (Number.isFinite(h) && h <= 2)) continue; // tracking pixel
      const alt = decodeEntities(tag.attrs.alt ?? '').replace(INVISIBLE, '').replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, 100);
      emit(alt ? `[image omitted: ${escapeMarkdownText(alt)}]` : '[image omitted]');
      continue;
    }
    if (name === 'a') {
      if (!closing) { stack.push({ kind: 'a', out: [], href: safeLinkUrl(tag.attrs.href) }); }
      else {
        const b = closeBuffer('a');
        if (b) {
          const label = b.out.join('').trim();
          if (b.href && label) emit(label === b.href ? `<${b.href}>` : `[${label.replace(/\n+/g, ' ')}](${b.href})`);
          else if (b.href) emit(`<${b.href}>`);
          else emit(label);
        }
      }
      continue;
    }
    if (name === 'blockquote') {
      if (!closing) { blockBreak(); stack.push({ kind: 'bq', out: [] }); }
      else {
        const b = closeBuffer('bq');
        if (b) { const body = b.out.join('').trim(); if (body) { emit(body.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')); emit('\n\n'); } }
      }
      continue;
    }
    if (name === 'pre') {
      if (!closing) { blockBreak(); stack.push({ kind: 'pre', out: [] }); inPre += 1; }
      else {
        inPre = Math.max(0, inPre - 1);
        const b = closeBuffer('pre');
        if (b) {
          // inside pre the text was escaped; undo that, it goes inside a fence where it is literal
          const body = b.out.join('').replace(/\\([\\`*_[\]<>|#+-])/g, '$1').replace(/\s+$/, '');
          const run = Math.max(2, ...(body.match(/`+/g) || ['']).map((r) => r.length)) + 1;
          const fence = '`'.repeat(run);
          emit(`${fence}\n${body}\n${fence}\n\n`);
        }
      }
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      if (!closing) { blockBreak(); emit(`${'#'.repeat(Number(name[1]))} `); } else { emit('\n\n'); }
      continue;
    }
    if (name === 'ul' || name === 'ol') {
      if (!closing) { lists.push({ ordered: name === 'ol', n: 0 }); blockBreak(); } else { lists.pop(); blockBreak(); }
      continue;
    }
    if (name === 'li') {
      if (!closing) {
        lineBreak();
        const l = lists[lists.length - 1];
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        if (l?.ordered) { l.n += 1; emit(`${indent}${l.n}. `); } else emit(`${indent}- `);
      } else lineBreak();
      continue;
    }
    if (name === 'td' || name === 'th') { if (closing) emit(' | '); continue; }
    if (name === 'tr') { if (closing) { const o = top().out; if (o.length) o[o.length - 1] = o[o.length - 1].replace(/ \| $/, ''); lineBreak(); } continue; }
    if (name === 'p' || BLOCK.has(name)) { blockBreak(); continue; }
    // every other tag (span, b, i, font, strong, ...) is transparent: its text is kept, the tag is dropped
  }
  while (stack.length > 1) { const b = stack.pop(); top().out.push(b.out.join('')); }
  let out = stack[0].out.join('')
    .replace(/[ \t]+\n/g, '\n').replace(/(?:\s*\|\s*)+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n\n[...truncated]`;
  return out;
}
