// Read-only repo file access for the global Code Assistant agent: `list-files`
// and `read-file`. Lets the agent find and read files in the project the user
// has open (the Explorer's workspace root) and in their indexed repos — the
// thing the chat could NOT do before (it only had KB + GitLab + web), which is
// why "find the README and review it" failed.
//
// SECURITY MODEL (read-only, scoped, traversal-proof):
//   - Readable roots = the DB repo allow-list (trusted; never client) ∪ the
//     open workspace root (client-supplied but validated: must be an existing
//     directory, not `..`-laden, and not a "too broad" root like / or $HOME).
//   - Every read/list resolves through realpath and must land INSIDE a root —
//     a `..` segment or a symlink pointing outside is rejected.
//   - A denylist drops secrets even inside an allowed root (.env, .ssh, *.pem,
//     id_rsa, …) so they can't be slurped into a prompt.
//   - Size/count caps bound the payload.
// Writes are NOT offered here — they keep going through the attach + confirm
// flow. This module never throws into the caller; failures return {error}.

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, isAbsolute, resolve, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { expandTilde } from '../../../graphkit/memory.mjs';
import { userRepoAllowlist } from '../../../kb/user.mjs';

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const MAX_READ_BYTES = 200_000;
const MAX_LIST_FILES = 400;

// Directories never walked / descended into.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.build', 'DerivedData', 'dist', 'build',
  '.next', 'Pods', 'vendor', '.venv', '.svn', '.hg', '.idea', '.gradle',
]);
// Path SEGMENTS whose presence denies the whole path (secret stores).
const DENY_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg']);
const DENY_BASENAMES = new Set(['.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'id_dsa', '.pgpass']);
const DENY_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore']);

function canon(p) { try { return realpathSync(p); } catch { return null; } }
function cmp(p) { return CASE_INSENSITIVE ? p.toLowerCase() : p; }

// True if `child` is the same as, or nested inside, `root` (both canonical).
function isWithin(child, root) {
  const c = cmp(child);
  const r = cmp(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

function isDeniedPath(absPath) {
  if (absPath.split(sep).some((s) => DENY_SEGMENTS.has(s))) return true;
  const base = basename(absPath);
  if (DENY_BASENAMES.has(base)) return true;
  if (base === '.env' || base.startsWith('.env.')) return true; // .env, .env.local, …
  const dot = base.lastIndexOf('.');
  if (dot > 0 && DENY_EXT.has(base.slice(dot).toLowerCase())) return true;
  return false;
}

// Refuse roots so broad that "read within" would mean "read most of the disk".
function isTooBroadRoot(real) {
  const home = canon(homedir()) || homedir();
  if (real === '/' || real === home) return true;
  if (cmp(real) === cmp(home)) return true;
  // Reject obvious system trees and depth-1 roots like /Users, /etc, /usr.
  const segs = real.split(sep).filter(Boolean);
  if (segs.length <= 1) return true;
  const top = sep + segs[0];
  if (['/etc', '/usr', '/var', '/bin', '/sbin', '/System', '/Library', '/private', '/opt'].includes(top)
      && segs.length <= 2) return true;
  return false;
}

// Canonical, real, deduped roots the agent may read within.
export function buildReadableRoots({ userId, workspaceRoot } = {}) {
  const out = [];
  const seen = new Set();
  const add = (p, { allowBroad = false } = {}) => {
    if (!p) return;
    const real = canon(p);
    if (!real) return;
    try { if (!statSync(real).isDirectory()) return; } catch { return; }
    if (!allowBroad && isTooBroadRoot(real)) return;
    const key = cmp(real);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(real);
  };
  // DB allow-list (indexed repos) — trusted source, read from the DB, never the
  // client. allowBroad: these were deliberately registered, so honor them as-is.
  try {
    if (userId) for (const p of userRepoAllowlist(userId)) add(resolve(expandTilde(p)), { allowBroad: true });
  } catch { /* DB hiccup — still allow the validated workspace root below */ }
  // Open workspace folder — client-supplied. The user explicitly opened it, but
  // it's not DB-trusted, so validate hard: absolute, no `..`, not too broad.
  if (typeof workspaceRoot === 'string' && workspaceRoot) {
    const exp = expandTilde(workspaceRoot);
    if (isAbsolute(exp) && !exp.split(/[/\\]/).includes('..')) add(resolve(exp));
  }
  return out;
}

// Resolve a requested path to a real, allowed, non-denied absolute path of the
// given kind ('file' | 'dir'), or null. Absolute requests must fall inside a
// root; relative requests are tried against each root in turn.
function resolveWithin(requested, roots, kind) {
  if (typeof requested !== 'string' || !requested || !roots?.length) return null;
  const exp = expandTilde(requested);
  if (exp.split(/[/\\]/).includes('..')) return null; // fail fast on traversal
  const candidates = isAbsolute(exp) ? [exp] : roots.map((r) => join(r, exp));
  for (const cand of candidates) {
    const real = canon(cand);
    if (!real) continue;
    if (isDeniedPath(real)) continue;
    let ok = false;
    try { ok = kind === 'dir' ? statSync(real).isDirectory() : statSync(real).isFile(); } catch { ok = false; }
    if (!ok) continue;
    if (roots.some((r) => isWithin(real, r))) return real;
  }
  return null;
}

export function resolveReadablePath(requested, roots) { return resolveWithin(requested, roots, 'file'); }

// Handler: list files under the readable roots (optionally scoped to a subdir,
// optionally filtered by a substring). Returns repo-relative paths.
export function handleListFiles(args, { roots } = {}) {
  if (!roots?.length) {
    return { error: 'No readable workspace — open a project folder or index a repo first.', files: [] };
  }
  let scanRoots = roots;
  if (typeof args?.subdir === 'string' && args.subdir.trim()) {
    const dir = resolveWithin(args.subdir, roots, 'dir');
    if (!dir) return { error: `Subdirectory not allowed or not found: ${args.subdir}`, files: [] };
    scanRoots = [dir];
  }
  const q = typeof args?.query === 'string' ? args.query.toLowerCase() : '';
  const files = [];
  let truncated = false;
  outer: for (const root of scanRoots) {
    const rootReal = canon(root);
    if (!rootReal) continue;
    const stack = [rootReal];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !DENY_SEGMENTS.has(e.name)) stack.push(full);
          continue;
        }
        if (!e.isFile() || isDeniedPath(full)) continue;
        const rel = full.slice(rootReal.length + 1);
        if (q && !rel.toLowerCase().includes(q)) continue;
        files.push(rel);
        if (files.length >= MAX_LIST_FILES) { truncated = true; break outer; }
      }
    }
  }
  files.sort();
  return { files, truncated };
}

// Handler: read one file's text content from within the readable roots.
export function handleReadFile(args, { roots } = {}) {
  if (!args?.path) return { error: 'Missing path argument' };
  const real = resolveReadablePath(args.path, roots);
  if (!real) {
    return { error: `Not allowed or not found: ${args.path}. Readable scope is the open workspace and your indexed repos (no secrets, no traversal).` };
  }
  let buf;
  try { buf = readFileSync(real); } catch (e) { return { error: `Couldn't read ${args.path}: ${e.message}` }; }
  // Binary guard: ≥1% NUL in the first 4K.
  const probe = buf.subarray(0, 4096);
  let nul = 0;
  for (const b of probe) if (b === 0) nul++;
  if (probe.length && nul * 100 >= probe.length) return { error: `${args.path} looks binary — not returned.` };
  let content = buf.toString('utf8');
  let truncated = false;
  if (buf.length > MAX_READ_BYTES) { content = content.slice(0, MAX_READ_BYTES); truncated = true; }
  return { path: args.path, content, truncated, bytes: buf.length };
}
