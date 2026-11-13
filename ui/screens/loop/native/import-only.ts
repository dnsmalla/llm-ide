// Which existing test files a unified git diff changes only by rewriting import statements. The Refactoring loop's move
// skills may re-point an existing test's imports after code moves; this decides whether a test's whole change is that.
// Pure: node tests import it directly. Fails closed: any doubt (rename, binary, new/deleted file, odd hunk, a line that
// is not a plain import) is "not".
//
// An import edit is eligible only when it MOVES names rather than changing them (a name is `imported as bound`, so
// `foo as X` -> `bar as X` is a change, not a move): the names on removed import lines equal
// (as a multiset) the names on added ones, and every module an added line imports is one the same file already imported
// or one the batch names. Module keys carry a language prefix: `py:` (dotted Python), `js:` (JS/TS specifier).

import { isTestFileName } from "./protected.ts";

interface Item { module: string; names: string[] }
interface Side { names: string[]; modules: Set<string>; block: string | null }
interface Entry { ok: boolean; changed: number; minus: Side; plus: Side }

const side = (): Side => ({ names: [], modules: new Set(), block: null });
const entry = (ok: boolean): Entry => ({ ok, changed: 0, minus: side(), plus: side() });

// Python. `import a.b as c` binds `c` (and `import a.b` binds `a.b`); a `from m import` binds each name or alias.
const PY_DOTTED = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/;
const PY_NAME = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/;
const PY_FROM = /^from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+(.+)$/;
const PY_BLOCK_OPEN = /^from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s*\($/;
// A line inside a paren block: comma-separated names (optional `as`), an optional closing `)`. Nothing else.
const PY_BLOCK_LINE = /^(?:\w+(?:\s+as\s+\w+)?\s*,\s*)*(?:\w+(?:\s+as\s+\w+)?\s*,?\s*)?\)?$/;
// JS/TS (and CommonJS).
const JS_IMPORT = /^import\s+(.+?)\s+from\s+(['"])([^'"]+)\2;?$/;
const JS_SIDE = /^import\s+(['"])([^'"]+)\1;?$/;
const JS_EXPORT = /^export\s+(?:\*(?:\s+as\s+(\w+))?|\{([^}]*)\})\s+from\s+(['"])([^'"]+)\3;?$/;
const CJS = /^(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))(?:\s*:\s*[^=]+?)?\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\);?$/;
const JS_NAME = /^(\w+)(?:\s+as\s+(\w+))?$/;
const CJS_NAME = /^(\w+)(?:\s*:\s*(\w+))?$/;

/** The module a Python `from m import (` line opens a paren block for, else null. */
function blockOpen(t: string): string | null {
  const m = PY_BLOCK_OPEN.exec(t);
  return m ? `py:${m[1]}` : null;
}

function pyImport(t: string): Item[] | null {
  const m = /^import\s+(.+)$/.exec(t);
  if (!m) return null;
  const items: Item[] = [];
  for (const part of m[1].split(",")) {
    const p = PY_DOTTED.exec(part.trim());
    if (!p) return null;
    items.push({ module: `py:${p[1]}`, names: [p[2] ? `${p[1]} as ${p[2]}` : p[1]] });
  }
  return items;
}

function pyFrom(t: string): Item[] | null {
  const m = PY_FROM.exec(t);
  if (!m) return null;
  const names: string[] = [];
  for (const part of m[2].split(",")) {
    const p = PY_NAME.exec(part.trim());
    if (!p) return null;
    names.push(p[2] ? `${p[1]} as ${p[2]}` : p[1]);
  }
  return [{ module: `py:${m[1]}`, names }];
}

/** The names of a JS import clause (`d`, `* as ns`, `{ a, b as c }`, or a mix). `type` imports are not handled: null. */
function jsClauseNames(clause: string): string[] | null {
  const c = clause.trim();
  if (c.startsWith("type ")) return null;
  const brace = c.indexOf("{");
  const def = (brace < 0 ? c : c.slice(0, brace)).replace(/,\s*$/, "").trim();
  const names: string[] = [];
  for (const part of def ? def.split(",") : []) {
    const p = part.trim();
    const ns = /^\*\s+as\s+(\w+)$/.exec(p);
    if (ns) names.push(ns[1]);
    else if (/^\w+$/.test(p)) names.push(p);
    else return null;
  }
  if (brace >= 0) {
    const inner = c.slice(brace);
    if (!inner.endsWith("}")) return null;
    for (const part of inner.slice(1, -1).split(",")) {
      const s = part.trim();
      if (s === "") continue;
      const p = JS_NAME.exec(s);
      if (!p) return null;
      names.push(p[2] ? `${p[1]} as ${p[2]}` : p[1]);
    }
  }
  return names;
}

function jsImport(t: string): Item[] | null {
  const m = JS_IMPORT.exec(t);
  if (!m) return null;
  const names = jsClauseNames(m[1]);
  return names === null ? null : [{ module: `js:${m[3]}`, names }];
}

/** `import 'm'`: binds no name, so the caller never accepts it. */
function jsSide(t: string): Item[] | null {
  const m = JS_SIDE.exec(t);
  return m ? [{ module: `js:${m[2]}`, names: [] }] : null;
}

/** `export … from 'm'`: the exported names (an alias is the exported name). `export * from` exports no name. */
function jsExport(t: string): Item[] | null {
  const m = JS_EXPORT.exec(t);
  if (!m) return null;
  const names: string[] = [];
  if (m[1] !== undefined) names.push(m[1]);
  if (m[2] !== undefined) {
    for (const part of m[2].split(",")) {
      const s = part.trim();
      if (s === "") continue;
      const p = JS_NAME.exec(s);
      if (!p) return null;
      names.push(p[2] ? `${p[1]} as ${p[2]}` : p[1]);
    }
  }
  return [{ module: `js:${m[4]}`, names }];
}

/** `const { a, b: c } = require('m')` / `let x: T = require("m")`: the bound local names. */
function cjs(t: string): Item[] | null {
  const m = CJS.exec(t);
  if (!m) return null;
  const names: string[] = [];
  if (m[1] !== undefined) {
    for (const part of m[1].split(",")) {
      const s = part.trim();
      if (s === "") continue;
      const p = CJS_NAME.exec(s);
      if (!p) return null;
      names.push(p[2] ? `${p[1]} as ${p[2]}` : p[1]);
    }
  } else {
    names.push(m[2]);
  }
  return [{ module: `js:${m[4]}`, names }];
}

/** Any single-line import statement, or null when the line is not one this file-level check can read. */
function statement(t: string): Item[] | null {
  return pyImport(t) ?? pyFrom(t) ?? jsImport(t) ?? jsSide(t) ?? jsExport(t) ?? cjs(t);
}

/** A line inside a Python paren block opened on `module`: its names (none for a bare `)`), or null when not a name line. */
function blockItems(t: string, module: string): Item[] | null {
  if (!PY_BLOCK_LINE.test(t)) return null;
  const names: string[] = [];
  for (const part of t.replace(/\)$/, "").split(",")) {
    const s = part.trim();
    if (s === "") continue;
    const p = PY_NAME.exec(s);
    if (!p) return null;
    names.push(p[2] ? `${p[1]} as ${p[2]}` : p[1]);
  }
  return names.length ? [{ module, names }] : [];
}

/** Whether `file` (a batch path) is where the module `mod` lives: `a.b` ↔ `a/b.py` or `a/b/__init__.py`; `./x/y` ↔ `x/y.*`. */
function moduleFile(mod: string, file: string): boolean {
  if (mod.startsWith("py:")) {
    const dotted = mod.slice(3);
    if (dotted.startsWith(".")) return false; // a relative Python import is never named by the plan
    const base = dotted.split(".").join("/");
    return [`${base}.py`, `${base}/__init__.py`].some((s) => file === s || file.endsWith(`/${s}`));
  }
  if (mod.startsWith("js:")) {
    const spec = mod.slice(3);
    if (!spec.startsWith("./") && !spec.startsWith("../")) return false; // a bare package is never named by the plan
    const seg = spec.split("/").filter((s) => s !== "" && s !== "." && s !== "..").join("/").replace(/\.[jt]sx?$/, "");
    if (seg === "") return false;
    const noExt = file.replace(/\.[^./]+$/, "");
    return [seg, `${seg}/index`].some((s) => noExt === s || noExt.endsWith(`/${s}`));
  }
  return false;
}

/** Names moved, not changed, and every added module already imported by the file or named by the batch. */
function eligible(e: Entry, allowed: readonly string[]): boolean {
  if (!e.ok || e.changed === 0 || e.minus.block !== null || e.plus.block !== null) return false;
  const was = [...e.minus.names].sort();
  const now = [...e.plus.names].sort();
  if (was.length === 0 || was.length !== now.length || was.some((n, i) => n !== now[i])) return false;
  return [...e.plus.modules].every((m) => e.minus.modules.has(m) || allowed.some((f) => moduleFile(m, f)));
}

function addItems(s: Side, items: readonly Item[]): void {
  for (const i of items) {
    s.names.push(...i.names);
    s.modules.add(i.module);
  }
}

/** One hunk line. A context line only keeps the paren-block state in step on both sides; a changed line must be an import. */
function readLine(e: Entry, kind: string, t: string): void {
  if (kind === " ") {
    const open = blockOpen(t);
    if (open !== null) {
      e.minus.block = open;
      e.plus.block = open;
    } else if (t.includes(")")) {
      e.minus.block = null;
      e.plus.block = null;
    }
    return;
  }
  if (t === "") return;
  e.changed++;
  const s = kind === "-" ? e.minus : e.plus;
  const open = blockOpen(t);
  if (open !== null) {
    s.block = open;
    s.modules.add(open);
    return;
  }
  let items: Item[] | null;
  if (s.block !== null) {
    items = blockItems(t, s.block);
    if (t.includes(")")) s.block = null;
  } else {
    items = statement(t);
  }
  // A side-effect import (no names) and an unreadable line both fail: only a name move is ever eligible.
  if (items === null || items.some((i) => i.names.length === 0)) {
    e.ok = false;
    return;
  }
  addItems(s, items);
}

/**
 * The candidate test files whose whole change is a name-preserving import move (see the header). A candidate must be
 * named like a test (`isTestFileName`); `allowedModules` is the batch's `- Files:` list. Candidates match `b/<path>` exactly.
 */
export function importOnlyFiles(diffText: string, candidates: readonly string[], allowedModules: readonly string[]): string[] {
  const entries = new Map<string, Entry>();
  let cur = entry(false); // before the first header, nothing is a candidate
  let path = "";
  let oldLeft = 0; // lines the current hunk still owes from its @@ counts
  let newLeft = 0;

  for (const line of diffText.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk the @@ counts say how many lines remain, so a removed `-- x` line is not a file header.
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const kind = line === "" ? " " : line[0];
      const fits = kind === " " ? oldLeft > 0 && newLeft > 0 : kind === "+" ? newLeft > 0 : kind === "-" ? oldLeft > 0 : false;
      if (fits) {
        if (kind !== "+") oldLeft--;
        if (kind !== "-") newLeft--;
        readLine(cur, kind, line.slice(1).trim());
        continue;
      }
      cur.ok = false; // a hunk that does not add up: distrust the file, then read this line as a header
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith("diff --git ")) {
      const p = headerPath(line.slice("diff --git ".length));
      path = p ?? "";
      cur = entry(p !== null);
      if (p !== null) entries.set(p, cur);
      continue;
    }
    if (/^(new file mode|deleted file mode|rename (from|to) |copy (from|to) |similarity index|dissimilarity index|Binary files |GIT binary patch)/.test(line)) {
      cur.ok = false;
    } else if (line.startsWith("+++ ")) {
      // /dev/null (a deleted file) or another name is not an in-place edit of this path.
      if (line.slice(4).replace(/\t$/, "") !== `b/${path}`) cur.ok = false;
    } else {
      const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (h) {
        oldLeft = h[1] === undefined ? 1 : Number(h[1]);
        newLeft = h[2] === undefined ? 1 : Number(h[2]);
        cur.minus.block = null; // a paren block cannot be carried across a hunk boundary
        cur.plus.block = null;
      }
    }
  }

  return candidates.filter((p) => {
    if (!isTestFileName(p)) return false; // conftest.py, __init__.py and helpers change how every test runs: judged
    const e = entries.get(p);
    return e !== undefined && eligible(e, allowedModules);
  });
}

/** The path of an unrenamed file from `a/P b/P` (the same P on both sides), else null. */
function headerPath(rest: string): string | null {
  if (!rest.startsWith("a/")) return null;
  const body = rest.slice(2);
  const half = (body.length - 3) / 2; // body = P + " b/" + P
  if (!Number.isInteger(half) || half < 1) return null;
  const p = body.slice(0, half);
  return body === `${p} b/${p}` ? p : null;
}
