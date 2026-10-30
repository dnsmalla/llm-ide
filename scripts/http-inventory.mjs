#!/usr/bin/env node
// HTTP inventory — writes schema/http/INVENTORY.md and fails on inconsistencies.
//
// Source of truth: two rosters, parsed from source text (the server is never
// imported: importing it boots it). ALL_ENDPOINTS in extension/server.mjs is the
// advertised roster. The public + auth roster (scripts/lib/roster.mjs) holds the
// pre-routing public paths (PUBLIC_PATHS, extension/server/auth.mjs) and the auth
// namespace (literal and prefix dispatch in extension/server/auth-routes.mjs, extension/routes/extension-routes.mjs and extension/routes/extensions-catalog.mjs).
// Feature ownership comes from FEATURE_ROUTE_GROUPS (extension/routes/feature-routes.mjs).
//
// Usage:
//   node scripts/http-inventory.mjs           regenerate INVENTORY.md, exit 1 on inconsistencies
//   node scripts/http-inventory.mjs --check   regenerate in memory, exit 1 if the file on disk
//                                             differs or any inconsistency is found (CI gate)
//
// Limits (see the report in the INVENTORY header too): handlers are found by
// scanning string literals on condition lines (===, startsWith, endsWith, if);
// a route built by other means (regex, computed path, a handler that dispatches
// on a variable) is reported as "no handler found" unless allowlisted. Method
// is taken from a `method === 'X'` on the same line as the path; otherwise "ANY".
// Client paths are literal strings in Swift/TS; concatenated paths
// ("/kb/x/" + id + "/y") are only seen as their literal prefix.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRosters } from './lib/roster.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_REL = 'schema/http/INVENTORY.md';
const SERVER_REL = 'extension/server.mjs';
const FEATURE_ROUTES_REL = 'extension/routes/feature-routes.mjs';
const AUTH_REL = 'extension/server/auth.mjs';
const MAC_DIR_REL = 'mac/Sources/LlmIdeMac';
const EXT_SRC_REL = 'extension/src';

// Files that dispatch routes. A handler match is attributed to the first file
// in this order that contains it (explicit-method matches win over bare
// string comparisons such as rate-limit profile lookups in server.mjs).
const HANDLER_FILES_REL = [
  ...listDir('extension/routes', (f) => f.endsWith('.mjs')),
  ...listDir('extension/server', (f) => f.endsWith('-routes.mjs')),
  SERVER_REL,
];

// Reasons are one line each. Keys: a roster path (noHandler), a normalized
// client path or a prefix ending in "/*" (clientNotInRoster), or a roster path
// listed twice (duplicate). Entries here are findings, not waivers for new code.
// clientNotInRoster is empty: the public + auth roster (/health, /launch-app and
// the /auth/* namespace) is now a roster, so clients resolve against it.
const ALLOWLIST = {
  noHandler: {
    '/auth/me/mcp-plugins/:id/update': 'dispatched by the regex mcpVersionMatch in extension/routes/extension-routes.mjs (/^\\/auth\\/me\\/mcp-plugins\\/…\\/(update|resync)$/), which the literal scanner cannot see',
    '/auth/me/mcp-plugins/:id/resync': 'dispatched by the regex mcpVersionMatch in extension/routes/extension-routes.mjs (/^\\/auth\\/me\\/mcp-plugins\\/…\\/(update|resync)$/), which the literal scanner cannot see',
  },
  clientNotInRoster: {},
  duplicate: {},
};

// ---------------------------------------------------------------- helpers

function listDir(relDir, keep) {
  const abs = join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter(keep).sort().map((f) => `${relDir}/${f}`);
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function walk(relDir, keep) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (name.name.startsWith('.') || name.name === 'build' || name.name === 'node_modules') continue;
      const rel = `${dir}/${name.name}`;
      if (name.isDirectory()) visit(rel);
      else if (keep(name.name)) out.push(rel);
    }
  };
  visit(relDir);
  return out.sort();
}

// Text lines that are code (not whole-line comments). A trailing `// …` is
// stripped only when it follows whitespace, so "http://" inside a string survives.
function codeLines(text) {
  return text.split('\n').map((raw, i) => {
    const t = raw.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return { n: i + 1, code: '' };
    return { n: i + 1, code: raw.replace(/\s\/\/\s.*$/, '') };
  });
}

// String literal contents on one line: '…', "…", `…` (template without ${} only).
function stringLiterals(code) {
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(code))) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v !== undefined) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- parsing sources

function parseFeatureGroups(src) {
  const m = /FEATURE_ROUTE_GROUPS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(src);
  if (!m) throw new Error(`FEATURE_ROUTE_GROUPS not found in ${FEATURE_ROUTES_REL}`);
  return [...m[1].matchAll(/^\s{2}(\w+): Object\.freeze\(\{\s*prefixes: Object\.freeze\(\[([^\]]*)\]\),\s*load:[^\n]*import\('\.\/([^']+)'\)/gm)].map((x) => ({
    key: x[1],
    prefixes: [...x[2].matchAll(/'([^']+)'/g)].map((p) => p[1]),
    module: `extension/routes/${x[3]}`,
  }));
}

function parsePublic(src) {
  const set = /const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  const pre = /const PUBLIC_PREFIXES = \[([^\]]*)\]/.exec(src);
  if (!set || !pre) throw new Error(`PUBLIC_PATHS / PUBLIC_PREFIXES not found in ${AUTH_REL}`);
  // One entry per line: comments in this block contain apostrophes.
  const paths = set[1].split('\n')
    .map((l) => /^\s*'(\/[^']*)'/.exec(l))
    .filter(Boolean)
    .map((x) => x[1]);
  const prefixes = [...pre[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return { paths: new Set(paths), prefixes };
}

// Handler candidates: every string literal starting with "/" on a condition
// line, or on a `const x = '/…'` declaration (a prefix a handler slices on).
// `subMethods[file][segment]`: methods of `method === …` lines that compare
// `sub` to a segment ('' for the bare id) — the sub-path dispatch in routes/chat.mjs.
function collectHandlerCandidates() {
  const cands = [];
  const subMethods = {};
  HANDLER_FILES_REL.forEach((rel, fileIdx) => {
    subMethods[rel] = {};
    const lines = codeLines(read(rel));
    for (const { n, code } of lines) {
      if (!code) continue;
      const methods = [...code.matchAll(/\bmethod\s*===\s*'([A-Z]+)'/g)].map((x) => x[1]);
      const subKey = /\bsub\s*===\s*'([^']*)'/.exec(code);
      if (methods.length && subKey) {
        subMethods[rel][subKey[1]] ??= new Set();
        methods.forEach((m) => subMethods[rel][subKey[1]].add(m));
      }
      // Sub-path comparisons (`sub === 'messages'`) name the path segment without its slash.
      const sub = /\bsub\s*===\s*'([^']*)'/.exec(code);
      if (sub && methods.length) cands.push({ lit: `/${sub[1]}`, file: rel, fileIdx, line: n, methods, isConst: false });
      const isCondition = /===|startsWith\(|endsWith\(|\bif\s*\(/.test(code);
      const isConst = /^\s*(const|let)\s+\w+\s*=/.test(code);
      if (!isCondition && !isConst) continue;
      for (const lit of stringLiterals(code)) {
        if (!lit.startsWith('/') || lit.includes('${')) continue;
        cands.push({ lit: lit.split('?')[0], file: rel, fileIdx, line: n, methods, isConst: isConst && !isCondition });
      }
    }
  });
  return { cands, subMethods };
}

// Every `method === 'X'` line in one file (for group modules that dispatch on
// the path inside the module rather than on a literal).
function methodLinesIn(rel) {
  return codeLines(read(rel))
    .map(({ n, code }) => ({ n, methods: [...code.matchAll(/\bmethod\s*===\s*'([A-Z]+)'/g)].map((x) => x[1]) }))
    .filter((x) => x.methods.length);
}

// ---------------------------------------------------------------- roster matching

function rosterShape(e) {
  const segs = e.split('/');
  const firstParam = segs.findIndex((s) => s.startsWith(':'));
  if (firstParam < 0) return { dynamic: false, prefix: e, tail: null };
  let lastParam = -1;
  segs.forEach((s, i) => { if (s.startsWith(':')) lastParam = i; });
  const prefix = segs.slice(0, firstParam).join('/') + '/';
  const tailSegs = segs.slice(lastParam + 1);
  return { dynamic: true, prefix, tail: tailSegs.length ? '/' + tailSegs.join('/') : null };
}

// Handler candidates for one roster entry, drawn from the candidate list.
// Each hit carries `exact`: true for a literal equal to the path (or a tail
// match on a parameterised path); false for a prefix dispatch such as
// `url.startsWith('/kb/plan/')`. Callers prefer exact hits.
function handlersFor(entry, cands) {
  const shape = rosterShape(entry);
  const out = [];
  for (const c of cands) {
    if (!shape.dynamic) {
      if (c.lit === entry) out.push({ ...c, exact: true });
      // A prefix dispatch (`url.startsWith('/kb/mcp-connector/')`) with a method check.
      else if (c.lit.length > 1 && c.lit.endsWith('/') && entry.startsWith(c.lit) && c.methods.length > 0) out.push({ ...c, exact: false });
    } else if (shape.tail) {
      // e.g. /kb/live/:id/append: the tail literal in a file that also names the prefix.
      if (c.lit === shape.tail && cands.some((d) => d.file === c.file && d.lit === shape.prefix)) out.push({ ...c, exact: true });
    } else if (c.lit === shape.prefix) {
      out.push({ ...c, exact: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------- client paths

const ROOTS = [
  'kb', 'agent-sdk', 'agent', 'code-assist', 'chat',
  'generate-notes', 'generate-docx', 'generate-doc', 'generate-questions',
  'extract-entities', 'auth', 'admin', 'metrics', 'health', 'launch-app',
];
const ROOT_RE = new RegExp(`(?<![A-Za-z0-9_.:/\\-])\\/(${ROOTS.join('|')})(?![A-Za-z0-9_\\-])`, 'g');

// Normalize the path that starts at `s` (a string literal's text from the root on):
// Swift \(…) and TS ${…} interpolations become "*"; the path ends at the first
// character outside the URL alphabet (quote, space, "?", backslash).
function normalizeFrom(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\\' && s[i + 1] === '(') {
      i = skipBalanced(s, i + 1, '(', ')');
      out += '*';
    } else if (s[i] === '$' && s[i + 1] === '{') {
      i = skipBalanced(s, i + 1, '{', '}');
      out += '*';
    } else if (/[A-Za-z0-9_\-./:*%]/.test(s[i])) {
      out += s[i++];
    } else break;
  }
  // A segment that is wholly interpolated stays "*"; one that mixes literal
  // text with an interpolation ("limits\(q)") keeps its literal part as a glob
  // ("limits*") so it cannot match an unrelated sibling segment.
  return out;
}

function skipBalanced(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i + 1;
  }
  return s.length;
}

function clientPathsIn(text) {
  const found = [];
  for (const { n, code } of codeLines(text)) {
    if (!code) continue;
    for (const lit of stringLiterals(code)) {
      ROOT_RE.lastIndex = 0;
      let m;
      while ((m = ROOT_RE.exec(lit))) {
        const p = normalizeFrom(lit.slice(m.index));
        if (p.length > 1 && p.startsWith('/')) found.push({ path: p, line: n });
      }
    }
  }
  return found;
}

// A client path whose only non-wildcard segment is the first one ("/kb/*", "/kb")
// says nothing about which route it calls. Such paths are listed as unresolvable.
function unresolvable(c) {
  const prefix = c.endsWith('/');
  const cs = (prefix ? c.slice(0, -1) : c).split('/').slice(1);
  if (prefix && cs.length === 1) return true; // "/kb/": a root with nothing after it
  // "/kb/*": a wildcard whose only fixed segment is the first one. A complete
  // static path such as "/health" is not this case.
  return cs.some((seg) => seg === '*') && cs.slice(1).every((seg) => seg === '*');
}

function clientMatchesRoster(c, e) {
  if (unresolvable(c)) return false;
  const prefix = c.endsWith('/');
  const cs = (prefix ? c.slice(0, -1) : c).split('/').slice(1);
  const es = e.split('/').slice(1);
  if (prefix ? es.length <= cs.length : es.length !== cs.length) return false;
  return cs.every((seg, i) => segMatches(seg, es[i]));
}

// One client segment against one roster segment. "*" (a wholly interpolated
// segment) matches anything; a glob like "limits*" matches only roster segments
// that fit its literal text; a roster parameter (":id") takes any client
// segment; otherwise the segments must be equal.
function segMatches(seg, rosterSeg) {
  if (seg === '*') return true;
  if (rosterSeg.startsWith(':')) return true;
  if (!seg.includes('*')) return seg === rosterSeg;
  const re = new RegExp(`^${seg.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(rosterSeg);
}

function clientAllowed(c) {
  if (Object.hasOwn(ALLOWLIST.clientNotInRoster, c)) return true;
  return Object.keys(ALLOWLIST.clientNotInRoster).some((k) => k.endsWith('/*') && c.startsWith(k.slice(0, -1)));
}

function collectClients(relFiles) {
  const hits = [];
  for (const rel of relFiles) {
    for (const { path, line } of clientPathsIn(read(rel))) hits.push({ path, file: rel, line });
  }
  return hits;
}

// Where a roster path is mentioned when no client calls it. Tests are any
// occurrence under extension/tests; comments/docs are an occurrence in docs/,
// a root *.md, or a comment line of extension/ or mac/ source (handler files
// included: their version-history comments name the routes).
function pathRegex(e) {
  const body = e.split('/').map((seg) => (seg.startsWith(':') ? "[^'\"`\\s/?]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`${body}(?![A-Za-z0-9_\\-/])`);
}

function loadCorpus() {
  const tests = walk('extension/tests', (f) => /\.(mjs|ts|tsx|js)$/.test(f)).map((rel) => ({ rel, lines: read(rel).split('\n') }));
  const docs = [...walk('docs', (f) => f.endsWith('.md')), ...listDir('.', (f) => f.endsWith('.md'))]
    .map((rel) => ({ rel, lines: read(rel).split('\n') }));
  const codeFiles = [
    ...walk('extension', (f) => /\.(mjs|ts|tsx|js)$/.test(f) && !/\.d\.ts$/.test(f)).filter((rel) => !rel.startsWith('extension/tests/') && !rel.includes('/node_modules/')),
    ...walk(MAC_DIR_REL, (f) => f.endsWith('.swift')),
  ];
  const commentLines = codeFiles.map((rel) => ({
    rel,
    lines: read(rel).split('\n').filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)),
  }));
  return { tests, docs, commentLines };
}

function referenceKind(e, corpus) {
  const re = pathRegex(e);
  if (corpus.tests.some((t) => t.lines.some((l) => re.test(l)))) return 'tests only';
  if (corpus.docs.some((d) => d.lines.some((l) => re.test(l)))) return 'comments/docs only';
  if (corpus.commentLines.some((c) => c.lines.some((l) => re.test(l)))) return 'comments/docs only';
  return 'no reference';
}

// ---------------------------------------------------------------- build the model

function build() {
  const rosters = loadRosters(read);
  const roster = [
    ...rosters.endpoints.map((r) => ({ ...r, file: SERVER_REL, roster: 'ALL_ENDPOINTS' })),
    ...rosters.publicAuth.map((r) => ({ ...r, roster: 'public+auth' })),
  ];
  const groups = parseFeatureGroups(read(FEATURE_ROUTES_REL));
  const pub = parsePublic(read(AUTH_REL));
  const { cands, subMethods } = collectHandlerCandidates();

  const macFiles = walk(MAC_DIR_REL, (f) => f.endsWith('.swift'));
  const macResourceFiles = walk(`${MAC_DIR_REL}/Resources`, (f) => f.endsWith('.json'));
  // api-types.ts is generated from these same routes; counting it as a caller would hide the gaps.
  const extFiles = walk(EXT_SRC_REL, (f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f) && !/(^|\/)api-types\.ts$/.test(f));
  const macClients = collectClients([...macFiles, ...macResourceFiles]);
  const extClients = collectClients(extFiles);

  const errors = [];
  const seen = new Map();
  for (const r of roster) {
    if (seen.has(r.path)) {
      if (!Object.hasOwn(ALLOWLIST.duplicate, r.path)) {
        errors.push(`duplicate roster entry ${r.path} (${r.roster}, line ${seen.get(r.path).line}; and line ${r.line})`);
      }
    } else seen.set(r.path, { line: r.line });
  }

  const corpus = loadCorpus();
  const rows = roster.map((r) => {
    const e = r.path;
    const shape0 = rosterShape(e);
    const hits = handlersFor(e, cands);
    const byPos = (a, b) => a.fileIdx - b.fileIdx || a.line - b.line;
    const explicit = hits.filter((h) => h.methods.length && !h.isConst).sort(byPos);
    const consts = hits.filter((h) => h.isConst).sort(byPos);
    const group0 = groups.find((g) => g.prefixes.some((p) => e.startsWith(p) || shape0.prefix.startsWith(p)));
    let best;
    let methods;
    if (explicit.length) {
      // Exact-literal matches win over prefix dispatch (/kb/plan/save is its own POST
      // line, not the GET /kb/plan/ prefix branch). Methods are those of the chosen tier.
      const exactTier = explicit.filter((h) => h.exact);
      const tier = exactTier.length ? exactTier : explicit;
      best = tier[0];
      methods = [...new Set(tier.flatMap((h) => h.methods))].sort();
    } else if (consts.length && subMethods[consts[0].file]?.[shape0.tail ? shape0.tail.slice(1) : ''] ) {
      // Sub-path dispatch: the prefix constant is sliced in that file and the
      // methods are the ones checked against this entry's sub-segment (chat.mjs).
      best = consts[0];
      methods = [...subMethods[best.file][shape0.tail ? shape0.tail.slice(1) : ''] ].sort();
    } else if (group0 && group0.module) {
      // Feature group whose module dispatches on the path itself (issue-schedule.mjs).
      const ml = methodLinesIn(group0.module);
      best = ml.length ? { file: group0.module, line: ml[0].n } : undefined;
      methods = [...new Set(ml.flatMap((x) => x.methods))].sort();
    } else {
      best = hits.sort(byPos)[0];
      methods = ['ANY'];
    }
    if (!methods.length) methods = ['ANY'];
    if (!best && !Object.hasOwn(ALLOWLIST.noHandler, e)) {
      errors.push(`${r.roster} ${e} (${r.file}:${r.line}) has no handler found by the scanner`);
    }
    const shape = rosterShape(e);
    const isPublic = pub.paths.has(e) || pub.prefixes.some((p) => e.startsWith(p) || shape.prefix.startsWith(p));
    const group = groups.find((g) => g.prefixes.some((p) => e.startsWith(p) || shape.prefix.startsWith(p)));
    const macHere = [...new Set(macClients.filter((c) => clientMatchesRoster(c.path, e)).map((c) => basename(c.file)))].sort();
    const extHere = [...new Set(extClients.filter((c) => clientMatchesRoster(c.path, e)).map((c) => basename(c.file)))].sort();
    const noCaller = macHere.length === 0 && extHere.length === 0;
    return {
      path: e,
      roster: r.roster,
      noCallerRef: noCaller ? referenceKind(e, corpus) : '-',
      methods: methods.join(', '),
      auth: isPublic ? 'public' : 'token',
      feature: group ? group.key : 'core',
      handler: best ? `${best.file}:${best.line}` : '-',
      mac: macHere,
      ext: extHere,
      line: r.line,
    };
  });

  // Client paths that match no roster entry.
  const unmatched = new Map();
  const unresolvableList = new Map();
  for (const c of [...macClients.map((x) => ({ ...x, src: 'Mac' })), ...extClients.map((x) => ({ ...x, src: 'extension' }))]) {
    if (unresolvable(c.path)) {
      if (!unresolvableList.has(c.path)) unresolvableList.set(c.path, []);
      unresolvableList.get(c.path).push(`${c.src} ${c.file}:${c.line}`);
      continue;
    }
    if (roster.some((r) => clientMatchesRoster(c.path, r.path))) continue;
    const key = c.path;
    if (!unmatched.has(key)) unmatched.set(key, { srcs: new Set(), where: [] });
    unmatched.get(key).srcs.add(c.src);
    unmatched.get(key).where.push(`${c.file}:${c.line}`);
  }
  // Stale allowlist entries fail too, so the list cannot rot.
  for (const k of Object.keys(ALLOWLIST.clientNotInRoster)) {
    const used = [...unmatched.keys()].some((c) => (k.endsWith('/*') ? c.startsWith(k.slice(0, -1)) : c === k));
    if (!used) errors.push(`stale ALLOWLIST.clientNotInRoster entry ${k}: no client calls it any more`);
  }
  for (const k of Object.keys(ALLOWLIST.noHandler)) {
    const row = rows.find((r) => r.path === k);
    if (!row || row.handler !== '-') errors.push(`stale ALLOWLIST.noHandler entry ${k}: it has a handler or is not in the roster`);
  }
  for (const k of Object.keys(ALLOWLIST.duplicate)) {
    if (!seen.has(k) || roster.filter((r) => r.path === k).length < 2) errors.push(`stale ALLOWLIST.duplicate entry ${k}`);
  }
  const allowedUnmatched = [];
  for (const [path, info] of [...unmatched.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (clientAllowed(path)) {
      allowedUnmatched.push({ path, srcs: [...info.srcs].sort(), where: info.where });
      continue;
    }
    errors.push(`client calls ${path} (${[...info.srcs].sort().join(', ')}: ${info.where.slice(0, 3).join(', ')}) which is not in ALL_ENDPOINTS`);
  }

  const unresolvableOut = [...unresolvableList.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, where]) => ({ path, where }));
  return { rows, groups, errors, allowedUnmatched, unresolvableOut, macFiles, extFiles, roster };
}

function basename(rel) {
  return rel.split(sep).join('/').split('/').pop();
}

// ---------------------------------------------------------------- render

function render(model) {
  const { rows, groups, errors, allowedUnmatched, unresolvableOut, macFiles, extFiles } = model;
  const total = rows.length;
  const count = (arr, key) => arr.reduce((acc, r) => {
    const k = key(r);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const bySeg = count(rows, (r) => r.path.split('/')[1]);
  const byGroup = count(rows, (r) => r.feature);
  const byAuth = count(rows, (r) => r.auth);
  const noClientRows = rows.filter((r) => r.mac.length === 0 && r.ext.length === 0);
  const noClient = noClientRows.map((r) => r.path);
  const refKinds = count(noClientRows, (r) => r.noCallerRef);
  const noHandler = rows.filter((r) => r.handler === '-').map((r) => r.path);

  const out = [];
  out.push('# HTTP inventory');
  out.push('');
  out.push('<!-- Generated by scripts/http-inventory.mjs. Do not edit by hand. -->');
  out.push('Regenerate: `node scripts/http-inventory.mjs` (CI: `node scripts/http-inventory.mjs --check`).');
  out.push('');
  out.push('Source of truth: `ALL_ENDPOINTS` in `extension/server.mjs`, and the public + auth roster');
  out.push('(`scripts/lib/roster.mjs`: `PUBLIC_PATHS` in `extension/server/auth.mjs`, dispatch in `extension/server/auth-routes.mjs`, `extension/routes/extension-routes.mjs` and `extension/routes/extensions-catalog.mjs`).');
  out.push('Feature groups from `extension/routes/feature-routes.mjs`.');
  out.push('Clients: Mac `mac/Sources/LlmIdeMac/**/*.swift` and `extension/src/**/*.ts(x)` string literals.');
  out.push('`*` in a client path = an interpolated or `:param` segment. Method `ANY` = no method check found.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`- Endpoints in \`ALL_ENDPOINTS\`: **${rows.filter((r) => r.roster === 'ALL_ENDPOINTS').length}**`);
  out.push(`- Public + auth roster (pre-routing public paths and the auth namespace; not advertised by \`/health\`): **${rows.filter((r) => r.roster === 'public+auth').length}**`);
  out.push(`- Auth: ${byAuth.token || 0} token, ${byAuth.public || 0} public`);
  out.push(`- Handler found: ${total - noHandler.length}; no handler found: ${noHandler.length}`);
  out.push(`- No Mac and no extension caller: ${noClient.length} (tests only: ${refKinds['tests only'] || 0}, comments/docs only: ${refKinds['comments/docs only'] || 0}, no reference: ${refKinds['no reference'] || 0})`);
  out.push('');
  out.push('By first path segment:');
  out.push('');
  out.push('| segment | endpoints |');
  out.push('|---|---:|');
  for (const k of Object.keys(bySeg).sort()) out.push(`| \`/${k}\` | ${bySeg[k]} |`);
  out.push('');
  out.push('By feature group (LLMIDE_FEATURES key; `core` = always on):');
  out.push('');
  out.push('| group | endpoints |');
  out.push('|---|---:|');
  const groupKeys = [...new Set(['core', ...groups.map((g) => g.key)])];
  for (const k of groupKeys) out.push(`| ${k} | ${byGroup[k] || 0} |`);
  out.push('');
  out.push(`Endpoints with no client caller (${noClient.length}):`);
  out.push('');
  out.push(noClientRows.length ? noClientRows.map((r) => `- \`${r.path}\` — ${r.noCallerRef}`).join('\n') : '- none');
  out.push('');
  out.push('## Endpoints');
  out.push('');
  out.push('| path | roster | methods | auth | feature | handler | Mac callers | extension callers | no-caller reference |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const list = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(', ') : '-');
    out.push(`| \`${r.path}\` | ${r.roster} | ${r.methods} | ${r.auth} | ${r.feature} | ${r.handler === '-' ? '-' : `\`${r.handler}\``} | ${list(r.mac)} | ${list(r.ext)} | ${r.noCallerRef} |`);
  }
  out.push('');
  out.push('## Consistency');
  out.push('');
  out.push(`Checked: ${total} roster entries, ${macFiles.length} Swift files, ${extFiles.length} extension source files.`);
  out.push('');
  // One line per allowlist key; a glob key lists the distinct paths it covers.
  const groupsOut = new Map();
  for (const a of allowedUnmatched) {
    const key = Object.hasOwn(ALLOWLIST.clientNotInRoster, a.path)
      ? a.path
      : `${a.path.split('/').slice(0, 2).join('/')}/*`;
    if (!groupsOut.has(key)) groupsOut.set(key, { srcs: new Set(), paths: [] });
    const g = groupsOut.get(key);
    a.srcs.forEach((x) => g.srcs.add(x));
    g.paths.push(a.path);
  }
  out.push(`Allowlisted client paths outside the roster (${allowedUnmatched.length} distinct paths, ${groupsOut.size} reasons):`);
  out.push('');
  if (groupsOut.size === 0) out.push('- none');
  for (const [key, g] of groupsOut) {
    const reason = ALLOWLIST.clientNotInRoster[key] ?? '';
    const paths = g.paths.length > 1 && key.endsWith('/*') ? `${g.paths.length} paths: ${g.paths.map((p) => `\`${p}\``).join(', ')}` : `\`${g.paths[0]}\``;
    out.push(`- \`${key}\` (${[...g.srcs].sort().join(', ')}) — ${reason}${g.paths.length > 1 && key.endsWith('/*') ? ' Covered: ' + paths : ''}`);
  }
  out.push('');
  out.push(`Unresolvable client paths (${unresolvableOut.length}): first segment only, not matched to any route:`);
  out.push('');
  if (unresolvableOut.length === 0) out.push('- none');
  for (const u of unresolvableOut) out.push(`- \`${u.path}\` (${u.where.slice(0, 3).join(', ')})`);
  out.push('');
  out.push(`Open inconsistencies (${errors.length}):`);
  out.push('');
  if (errors.length === 0) out.push('- none');
  for (const e of errors) out.push(`- ${e}`);
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------- main

function main() {
  const check = process.argv.includes('--check');
  const model = build();
  const text = render(model);
  const outAbs = join(ROOT, OUT_REL);
  let failed = model.errors.length > 0;

  if (check) {
    const onDisk = existsSync(outAbs) ? readFileSync(outAbs, 'utf8') : null;
    if (onDisk !== text) {
      process.stderr.write(`${OUT_REL} is stale or missing; run: node scripts/http-inventory.mjs\n`);
      failed = true;
    }
  } else {
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, text);
    process.stdout.write(`wrote ${relative(ROOT, outAbs)} (${model.rows.length} endpoints)\n`);
  }

  if (model.errors.length) {
    process.stderr.write(`\n${model.errors.length} inconsistenc${model.errors.length === 1 ? 'y' : 'ies'}:\n`);
    for (const e of model.errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write('Fix the code/roster, or add a reasoned entry to ALLOWLIST in scripts/http-inventory.mjs.\n');
  }
  process.exit(failed ? 1 : 0);
}

main();
