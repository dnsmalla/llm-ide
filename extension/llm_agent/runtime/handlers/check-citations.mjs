// check-citations: the plan-mode output check. The model passes the document
// it is about to present; this reports every cited file that does not exist,
// every `path:line` past the end of its file, and every code symbol the
// repo-scoped graph does not know — so the model fixes them in the same turn.
// Read-only; returns names and numbers only, never file contents.
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentPath, orderRoots } from './find-code.mjs';
import { resolveRepoScope, existingSymbolTitles, hasCodeGraph } from '../../../kb/db.mjs';

const MAX_TEXT = 200_000;
const MAX_ITEMS = 100;
const MAX_LINECOUNT_BYTES = 2 * 1024 * 1024;

const SPAN = /`([^`\n]{2,200})`/g;
const PATH_RE = /^(?<p>(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.[A-Za-z0-9]{1,8})(?::(?<a>\d+)(?:-(?<b>\d+))?)?$/;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
// A bare `name.ext` (no slash) is a path only for real source/doc extensions;
// otherwise `Store.save` or `config.value` would be judged as missing files.
const KNOWN_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'swift', 'py', 'md', 'json',
  'yml', 'yaml', 'toml', 'sql', 'sh', 'go', 'rs', 'kt', 'java', 'c', 'h', 'cpp', 'm', 'mm',
  'html', 'css', 'txt', 'plist', 'xml']);

// Only two shapes are judged against the graph, because the graph holds just
// function / class-or-type / file nodes: a CALL (`foo()`, `a.b()`) and a
// PascalCase TYPE name. Properties, locals and dotted members without a call
// (`activeProject`, `Store.save`) are never judged — they are not graph nodes.
const BUILTIN_ROOTS = new Set(['JSON', 'Array', 'Object', 'Math', 'Promise', 'Date', 'String',
  'Number', 'Boolean', 'Symbol', 'Map', 'Set', 'RegExp', 'Error', 'Reflect', 'Intl', 'Buffer',
  'URL', 'URLSearchParams', 'process', 'console', 'fs', 'path', 'os', 'crypto', 'http', 'https',
  'child_process', 'window', 'document', 'navigator', 'React', 'Foundation', 'FileManager',
  'DispatchQueue', 'NSString', 'UserDefaults']);

const PASCAL_RE = /^[A-Z][a-z0-9]+[A-Za-z0-9]*$/;

function looksLikeSymbol(s) {
  const isCall = /\(\)$/.test(s);
  const bare = s.replace(/\(\)$/, '');
  if (/^[A-Z0-9_]+$/.test(bare)) return false;            // env vars, constants
  if (BUILTIN_ROOTS.has(bare.split('.')[0])) return false;
  if (isCall) return true;
  return PASCAL_RE.test(bare);                            // bare type name, no dots
}

export function extractCitations(text) {
  const paths = [];
  const symbols = new Set();
  const seenPaths = new Set();
  for (const m of String(text || '').matchAll(SPAN)) {
    const span = m[1].trim();
    const pm = PATH_RE.exec(span);
    const bareExt = pm && !pm.groups.p.includes('/') ? pm.groups.p.split('.').pop().toLowerCase() : null;
    if (pm && (pm.groups.p.includes('/') || KNOWN_EXT.has(bareExt))) {
      const key = `${pm.groups.p}:${pm.groups.a || ''}`;
      if (!seenPaths.has(key) && paths.length < MAX_ITEMS) {
        seenPaths.add(key);
        paths.push({
          path: pm.groups.p,
          line: pm.groups.a ? Number(pm.groups.a) : null,
          endLine: pm.groups.b ? Number(pm.groups.b) : null,
        });
      }
      continue;
    }
    if (SYMBOL_RE.test(span) && span.length >= 3 && span.length <= 80 && looksLikeSymbol(span)) {
      const last = span.replace(/\(\)$/, '').split('.').pop();
      if (last && symbols.size < MAX_ITEMS) symbols.add(last);
    }
  }
  return { paths, symbols: [...symbols] };
}

function lineCount(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_LINECOUNT_BYTES) return null;
    const body = fs.readFileSync(absPath, 'utf8');
    if (body.length === 0) return 0;
    return body.endsWith('\n') ? body.split('\n').length - 1 : body.split('\n').length;
  } catch {
    return null;
  }
}

// Only the validated readable roots are consulted (workspace first when it is
// one of them) — the raw client workspaceRoot is never read from here.
function absoluteFor(relPath, roots, workspaceRoot) {
  for (const root of orderRoots(roots, workspaceRoot)) {
    const abs = path.join(root, relPath);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

export function handleCheckCitations(args, ctx) {
  const text = typeof args?.text === 'string' ? args.text.slice(0, MAX_TEXT) : '';
  if (!text.trim()) return { error: 'text is required' };
  if (!ctx?.userId) return { error: 'not signed in' };
  const roots = Array.isArray(ctx.roots) ? ctx.roots : [];
  const workspaceRoot = typeof ctx.workspaceRoot === 'string' ? ctx.workspaceRoot : '';
  const activeRepoRoot = typeof ctx.activeRepoRoot === 'string' ? ctx.activeRepoRoot : '';

  const { paths, symbols } = extractCitations(text);
  const missingPaths = [];
  const lineOutOfRange = [];
  const lineCounts = new Map();   // abs path -> lines, so a file cited on several lines is read once
  for (const c of paths) {
    // Bare filenames (no `/`) are ambiguous — they can live anywhere — so
    // they are extracted but never judged.
    if (!c.path.includes('/')) continue;
    const resolved = resolveAgentPath(c.path, roots, workspaceRoot);
    if (!resolved || !resolved.exists) { missingPaths.push(c.path); continue; }
    const want = c.endLine || c.line;
    if (!want) continue;
    const abs = absoluteFor(resolved.path, roots, workspaceRoot);
    let lines = null;
    if (abs) {
      if (!lineCounts.has(abs)) lineCounts.set(abs, lineCount(abs));
      lines = lineCounts.get(abs);
    }
    if (lines !== null && want > lines) lineOutOfRange.push({ path: c.path, line: want, lines });
  }

  let unknownSymbols = [];
  let graphChecked = false;
  try {
    const repoIds = resolveRepoScope(ctx.userId, { activeRepoRoot, workspaceRoot });
    // Only judge symbols against a graph that is scoped to THIS repo: an
    // unscoped or absent graph would call every real symbol "unknown".
    if (repoIds && hasCodeGraph(ctx.userId) && symbols.length > 0) {
      const known = existingSymbolTitles(ctx.userId, symbols, { repoIds });
      unknownSymbols = symbols.filter((s) => !known.has(s));
      graphChecked = true;
    } else if (repoIds && hasCodeGraph(ctx.userId)) {
      graphChecked = true;
    }
  } catch {
    graphChecked = false;
    unknownSymbols = [];
  }

  return {
    ok: missingPaths.length === 0 && lineOutOfRange.length === 0 && unknownSymbols.length === 0,
    checked: { paths: paths.length, symbols: symbols.length },
    missingPaths,
    lineOutOfRange,
    unknownSymbols,
    graphChecked,
  };
}
