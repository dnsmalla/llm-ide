// Allowlist SVG sanitiser for mermaid output. The SVG comes out of a sandboxed frame (which already ran mermaid in
// `strict` mode), so this is the parent's own second layer: it never trusts the frame. It is a small tokenizer, not a
// DOM, so it runs (and is tested) without a browser: it parses tags itself, keeps ONLY allowlisted elements and
// attributes, re-serialises from scratch, and answers `null` for anything structurally wrong.
//
// Dropped with their whole subtree: script, foreignObject, image, iframe, object, embed, animate*, set, filter, mask,
// pattern, symbol, switch, a (children are kept, the link is not), anything unknown. Dropped attributes: on*, style
// that is not plain declarations, any value that holds a URL other than `url(#id)` / `#id`, `javascript:` / `data:` /
// `vbscript:` text, backslash escapes, markup characters. Result is shown through `<img src=blob:>`, where an SVG can
// neither run script nor load anything, so a miss here still would not execute.

export const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 100;
const MAX_ELEMENTS = 100_000;
const MAX_ATTR_CHARS = 200_000;

const ELEMENTS = new Set([
  "svg", "g", "defs", "marker", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc",
  "style", "linearGradient", "radialGradient", "stop", "clipPath", "use",
]);
const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc"]);
/** Elements whose tag is removed but whose children are kept. */
const UNWRAP = new Set(["a"]);

const ATTRS = new Set([
  "id", "class", "style", "transform", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height",
  "viewBox", "preserveAspectRatio", "points", "dx", "dy", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "font-family", "font-size",
  "font-weight", "font-style", "text-anchor", "dominant-baseline", "alignment-baseline", "letter-spacing", "text-decoration", "visibility",
  "display", "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient", "clip-path",
  "clip-rule", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "xml:space", "role", "aria-label",
  "aria-roledescription", "aria-labelledby", "aria-describedby", "version", "color", "overflow", "href", "xlink:href",
]);

export type SvgResult = { ok: true; svg: string; dropped: number } | { ok: false; reason: string };

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the five XML entities and numeric references; any other `&name;` is kept as literal text. */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-z]{2,6}));/g, (m, hex?: string, dec?: string, name?: string) => {
    if (name) return NAMED[name] ?? m;
    const cp = hex ? parseInt(hex, 16) : parseInt(dec as string, 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
    return String.fromCodePoint(cp);
  });
}

const escText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => escText(s).replace(/"/g, "&quot;");
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const SAFE_URL_FN = /^url\(\s*(['"]?)#[\w:.\-]+\1\s*\)/i;

/** True when every `url(` in `v` is a same-document fragment reference. */
function urlsAreLocal(v: string): boolean {
  const re = /url\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    if (!SAFE_URL_FN.test(v.slice(m.index))) return false;
  }
  return true;
}

/** Text that would be dangerous in any context, found after removing whitespace and control characters. */
function hasDangerousToken(v: string): boolean {
  const flat = v.replace(/[\s\u0000-\u001f\u007f]+/g, "").toLowerCase();
  return /javascript:|vbscript:|data:|expression\(|-moz-binding|behavior:|livescript:/.test(flat);
}

export function isSafeCss(css: string): boolean {
  if (css.length > MAX_ATTR_CHARS || css.includes("\\") || css.includes("<") || CONTROL.test(css)) return false;
  if (hasDangerousToken(css)) return false;
  if (!urlsAreLocal(css)) return false;
  if (/image-set\s*\(|\bsrc\s*\(|\bimage\s*\(|-webkit-image-set/i.test(css)) return false;
  for (const m of css.matchAll(/@([\w-]+)/g)) {
    if (!/^(keyframes|media|-webkit-keyframes)$/i.test(m[1] as string)) return false;
  }
  return true;
}

function safeAttr(name: string, raw: string): string | null {
  if (!ATTRS.has(name)) return null;
  if (raw.length > MAX_ATTR_CHARS) return null;
  const v = decodeEntities(raw);
  if (CONTROL.test(v) || v.includes("<") || v.includes(">") || v.includes("`") || v.includes("\\")) return null;
  if (name === "href" || name === "xlink:href") return /^#[A-Za-z_][\w:.\-]*$/.test(v.trim()) ? v.trim() : null;
  if (name === "style") return isSafeCss(v) ? v : null;
  if (name === "id" || name === "class") return /^[\w:.\- ]{0,300}$/.test(v) ? v : null;
  if (hasDangerousToken(v) || !urlsAreLocal(v)) return null;
  return v;
}

interface Attr {
  name: string;
  value: string;
}

interface Tag {
  kind: "open" | "close" | "selfclose";
  name: string;
  attrs: Attr[];
  end: number;
}

/** Parses the tag starting at `i` (`s[i] === "<"`). `null` = malformed. */
function readTag(s: string, i: number): Tag | null {
  let p = i + 1;
  const close = s[p] === "/";
  if (close) p += 1;
  const nm = /^[A-Za-z][\w:.\-]*/.exec(s.slice(p, p + 80));
  if (!nm) return null;
  const name = nm[0];
  p += name.length;
  const attrs: Attr[] = [];
  for (;;) {
    while (p < s.length && /\s/.test(s[p] as string)) p += 1;
    if (p >= s.length) return null;
    const c = s[p];
    if (c === ">") return { kind: close ? "close" : "open", name, attrs, end: p + 1 };
    if (c === "/" && s[p + 1] === ">") return close ? null : { kind: "selfclose", name, attrs, end: p + 2 };
    if (close) return null;
    const an = /^[^\s=/>"'<]+/.exec(s.slice(p, p + 120));
    if (!an) return null;
    p += an[0].length;
    while (p < s.length && /\s/.test(s[p] as string)) p += 1;
    let value = "";
    if (s[p] === "=") {
      p += 1;
      while (p < s.length && /\s/.test(s[p] as string)) p += 1;
      const q = s[p];
      if (q !== '"' && q !== "'") return null;
      const e = s.indexOf(q, p + 1);
      if (e < 0) return null;
      value = s.slice(p + 1, e);
      p = e + 1;
    }
    if (attrs.length >= 200) return null;
    attrs.push({ name: an[0], value });
  }
}

export function sanitizeSvg(input: unknown): SvgResult {
  if (typeof input !== "string") return { ok: false, reason: "The diagram output was not text." };
  if (new TextEncoder().encode(input).length > MAX_SVG_BYTES) return { ok: false, reason: "The diagram output is larger than 2 MB." };
  const s = input;
  const out: string[] = [];
  /** Open elements: `emit` = was the tag written; `skip` = inside a dropped subtree. */
  const stack: { name: string; emit: boolean }[] = [];
  let skipDepth = 0;
  let dropped = 0;
  let elements = 0;
  let rootSeen = false;
  let rootClosed = false;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const textEnd = lt < 0 ? s.length : lt;
    if (textEnd > i) {
      const text = s.slice(i, textEnd);
      if (stack.length === 0) {
        if (/\S/.test(text)) return { ok: false, reason: "The diagram output has text outside the SVG." };
      } else if (skipDepth === 0) {
        const top = stack[stack.length - 1] as { name: string; emit: boolean };
        if (top.emit && TEXT_ELEMENTS.has(top.name)) out.push(escText(decodeEntities(text).replace(new RegExp(CONTROL.source, "g"), "")));
      }
    }
    if (lt < 0) break;
    if (s.startsWith("<!--", lt)) {
      const e = s.indexOf("-->", lt + 4);
      if (e < 0) return { ok: false, reason: "The diagram output has an unterminated comment." };
      i = e + 3;
      continue;
    }
    if (s[lt + 1] === "!" || s[lt + 1] === "?") return { ok: false, reason: "The diagram output has a declaration, CDATA or processing instruction." };
    const tag = readTag(s, lt);
    if (!tag) return { ok: false, reason: "The diagram output has a malformed tag." };
    i = tag.end;
    if (tag.kind === "close") {
      const top = stack.pop();
      if (!top || top.name !== tag.name) return { ok: false, reason: "The diagram output has mismatched tags." };
      if (skipDepth > 0) {
        skipDepth -= 1;
      } else if (top.emit) {
        out.push(`</${top.name}>`);
      }
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    // open or self-closing
    elements += 1;
    if (elements > MAX_ELEMENTS) return { ok: false, reason: "The diagram output has too many elements." };
    if (stack.length === 0) {
      if (rootSeen || rootClosed || tag.name !== "svg") return { ok: false, reason: "The diagram output is not a single SVG." };
      rootSeen = true;
    }
    const selfClose = tag.kind === "selfclose";
    const name = tag.name;
    // `style` holds raw text: read to its closing tag (CSS may contain `>`), never parse inside it.
    if (name === "style" && !selfClose && skipDepth === 0) {
      const rel = s.slice(i).search(/<\/style\s*>/i);
      if (rel < 0) return { ok: false, reason: "The diagram output has an unterminated style element." };
      const css = decodeEntities(s.slice(i, i + rel));
      const endTag = /^<\/style\s*>/i.exec(s.slice(i + rel)) as RegExpExecArray;
      i = i + rel + endTag[0].length;
      if (isSafeCss(css)) out.push(`<style>${css}</style>`);
      else dropped += 1;
      continue;
    }
    let emit = false;
    if (skipDepth > 0) {
      if (!selfClose) {
        stack.push({ name, emit: false });
        skipDepth += 1;
      }
      continue;
    }
    if (UNWRAP.has(name)) {
      dropped += 1;
      if (!selfClose) stack.push({ name, emit: false });
      continue;
    }
    if (!ELEMENTS.has(name)) {
      dropped += 1;
      if (!selfClose) {
        stack.push({ name, emit: false });
        skipDepth += 1;
      }
      continue;
    }
    if (name === "use") {
      const href = tag.attrs.find((a) => a.name === "href" || a.name === "xlink:href");
      if (!href || safeAttr(href.name, href.value) === null) {
        dropped += 1;
        if (!selfClose) {
          stack.push({ name, emit: false });
          skipDepth += 1;
        }
        continue;
      }
    }
    emit = true;
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const a of tag.attrs) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue; // re-emitted on the root, fixed
      if (seen.has(a.name)) continue;
      seen.add(a.name);
      const v = safeAttr(a.name, a.value);
      if (v === null) {
        dropped += 1;
        continue;
      }
      parts.push(` ${a.name}="${escAttr(v)}"`);
    }
    const root = name === "svg" && stack.length === 0 ? ' xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' : "";
    out.push(`<${name}${root}${parts.join("")}${selfClose ? "/>" : ">"}`);
    if (!selfClose) {
      stack.push({ name, emit });
      if (stack.length > MAX_DEPTH) return { ok: false, reason: "The diagram output is nested too deeply." };
    } else if (stack.length === 0) {
      rootClosed = true;
    }
  }
  if (stack.length > 0 || !rootSeen) return { ok: false, reason: "The diagram output is incomplete." };
  const svg = out.join("");
  if (new TextEncoder().encode(svg).length > MAX_SVG_BYTES) return { ok: false, reason: "The diagram output is larger than 2 MB." };
  return { ok: true, svg, dropped };
}
