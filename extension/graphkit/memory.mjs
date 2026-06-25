// Renders the `## Repository memory (Graphify)` section.
//
// Bridges the Mac app's Graphify-generated memory files into the in-app
// agent's system prompt. Previously the Mac app wrote rich `repo.md`,
// `graph-notes.md`, and bug/Q&A entries under `<repo>/graphify-out/memory/`
// but only external CLIs (Claude/Cursor) read them — the llm-ide
// `/code-assist` agent ignored them. This module closes that loop.
//
// Safety rails:
// - Only reads from paths the user has already declared as indexed repos
//   (agentContext.indexedRepos) — no arbitrary path traversal.
// - Reads only a fixed allow-list of filenames inside `graphify-out/memory/`.
// - Hard caps both per-file and total characters so memory growth can't
//   blow the prompt budget.
// - All I/O is best-effort: missing files / read errors collapse to a
//   silent skip, never throw.

import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { userRepoAllowlist } from '../kb/db.mjs';

// Expand a leading `~`/`~/` to the home directory. The Mac client sends
// home-relative repo paths (homeRelativePath → "~/Developer/foo"), but the
// reader and the allow-list both work in absolute terms — without this, every
// home-dir repo's memory was silently dropped at the isAbsolute() gate. The
// server is always local (clients only reach 127.0.0.1:3456), so the server's
// home equals the client's. Exported for testing.
export function expandTilde(p, home = homedir()) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

const PER_FILE_CHARS = 4_000;
const TOTAL_CHARS = 16_000;
const MAX_BUG_FILES = 8;
const MAX_QA_FILES = 8;
// Cap the number of repos whose memory we inline. The list comes from
// agentContext.indexedRepos but Graphify memory is heavy — surfacing
// more than two repos at once dilutes the signal and bloats the prompt.
const MAX_REPOS = 2;

// Relative-age phrase for a file mtime. Pure + exported for unit tests.
// Facts only: a future/non-finite delta (clock skew, bad input) clamps to
// "just now" rather than emitting a negative or NaN age.
export function relativeAge(mtimeMs, nowMs = Date.now()) {
  const delta = nowMs - mtimeMs;
  if (!Number.isFinite(delta) || delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `~${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `~${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `~${days} day${days === 1 ? '' : 's'} ago`;
}

// Newest mtime (epoch ms) across the given paths, or null if none stat.
// Best-effort: a missing/unstattable file is skipped, never throws.
function newestMtimeMs(paths) {
  let newest = null;
  for (const p of paths) {
    try {
      const ms = statSync(p).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch { /* missing / unstattable — skip */ }
  }
  return newest;
}

function safeRead(path, maxChars) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    // Small file: read it whole and slice. Large file: read only the
    // first maxChars bytes via a bounded fd read rather than loading a
    // multi-MB memory file into RAM just to slice the head off it.
    // (At a UTF-8 byte boundary the tail char may be clipped — fine for
    // a prompt excerpt; result is always ≤ maxChars chars.)
    if (st.size <= maxChars * 4) {
      return readFileSync(path, 'utf8').slice(0, maxChars);
    }
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxChars);
      const n = readSync(fd, buf, 0, maxChars, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function listMdFiles(dir, max) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
      .slice(0, max)
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

// macOS APFS in its default mode is case-insensitive — '/Users/Alice'
// and '/Users/alice' point at the same directory. The allowlist set
// uses literal-string equality, so a user registered with one casing
// and indexedRepos sent with another would silently fail the gate
// and produce an empty memory section. Lowercase the lookup key on
// darwin (Linux/Windows servers stay case-sensitive — these would
// almost never serve a Mac client in any case, but stay strict).
function normalizeForCompare(p) {
  return process.platform === 'darwin' ? p.toLowerCase() : p;
}

// Tenancy + traversal gate, shared by the reader and the chat-memory writer
// (memory-writer.mjs). Given a client-supplied repo path and the user's
// allow-set, return the absolute, allow-listed repo root — or null if the path
// is relative, contains a `..` segment, or is not in the allow-list.
//
// This is the single security boundary for ALL filesystem access into a repo's
// graphify-out/ tree: anything that resolves a repo path to disk MUST go
// through here so a hostile/buggy client can't drive reads or writes outside
// the user's registered repos.
export function resolveAllowedRepoRoot(repoPath, allowedRoots) {
  if (typeof repoPath !== 'string' || !repoPath) return null;
  // The Mac client sends home-relative paths ("~/…"); expand to absolute.
  const expanded = expandTilde(repoPath);
  // Defense-in-depth: reject an unresolved parent-traversal segment. (resolve()
  // collapses it and the allow-list gates the result anyway, but fail fast.)
  if (expanded.split(/[/\\]/).includes('..')) return null;
  // Only honor absolute paths post-expansion. A still-relative path would be
  // ambiguous server-side.
  if (!isAbsolute(expanded)) return null;
  // Tenancy gate: the path must be in the user's registered repo allow-list.
  // resolve() is applied to both sides so `/foo/../bar` and `/bar` compare
  // equal. Pass through normalizeForCompare so APFS case-variants match.
  const root = resolve(normalize(expanded));
  if (!allowedRoots.has(normalizeForCompare(root))) return null;
  return root;
}

// Build the per-user allow-set, normalised the same way resolveAllowedRepoRoot
// normalises candidate paths, so the .has() comparison is symmetric. A user
// with no registered repos gets an empty set → every repo fails the gate.
// Returns null on a DB error so callers can fail closed.
export function buildAllowedRoots(userId) {
  if (!userId) return null;
  try {
    return new Set(
      userRepoAllowlist(userId)
        .filter((p) => typeof p === 'string' && p)
        // Expand tilde defensively in case a legacy allow-list entry is
        // home-relative.
        .map((p) => normalizeForCompare(resolve(normalize(expandTilde(p))))),
    );
  } catch {
    return null;
  }
}

function repoMemoryBlock(repo, budget, allowedRoots) {
  if (!repo) return null;
  const root = resolveAllowedRepoRoot(repo.path, allowedRoots);
  if (!root) return null;
  const memDir = join(root, 'graphify-out', 'memory');

  const parts = [];
  let used = 0;
  const tryAdd = (label, body) => {
    if (!body) return;
    const trimmed = body.trim();
    if (!trimmed) return;
    const room = budget - used;
    if (room <= 200) return; // not worth a header for a tiny remainder
    const clipped = trimmed.length > room ? `${trimmed.slice(0, room)}\n…(truncated)` : trimmed;
    parts.push(`### ${label}\n${clipped}`);
    used += clipped.length + label.length + 6;
  };

  tryAdd('repo.md', safeRead(join(memDir, 'repo.md'), PER_FILE_CHARS));
  tryAdd('graph-notes.md', safeRead(join(memDir, 'graph-notes.md'), PER_FILE_CHARS));
  tryAdd('doc-notes.md', safeRead(join(memDir, 'doc-notes.md'), PER_FILE_CHARS));
  // Auto-captured facts the Code Assistant learned in prior chats about this
  // project (written by memory-writer.mjs after each turn). Same dir, same
  // gate — recall is free because this reader already runs every request.
  tryAdd('chat-memory.md', safeRead(join(memDir, 'chat-memory.md'), PER_FILE_CHARS));

  const bugs = listMdFiles(join(memDir, 'bugs'), MAX_BUG_FILES);
  if (bugs.length > 0 && used < budget) {
    const bugBodies = bugs
      .map((p) => safeRead(p, Math.floor(PER_FILE_CHARS / 2)))
      .filter(Boolean)
      .join('\n\n---\n\n');
    tryAdd(`bugs/ (${bugs.length})`, bugBodies);
  }

  const qa = listMdFiles(join(memDir, 'q&a'), MAX_QA_FILES);
  if (qa.length > 0 && used < budget) {
    const qaBodies = qa
      .map((p) => safeRead(p, Math.floor(PER_FILE_CHARS / 2)))
      .filter(Boolean)
      .join('\n\n---\n\n');
    tryAdd(`q&a/ (${qa.length})`, qaBodies);
  }

  const name = repo.name || 'Repository';
  if (parts.length === 0) {
    // Allow-gate passed but no readable memory: tell the agent explicitly
    // instead of contributing nothing. (The path/tenancy guards above still
    // return null and stay silent — this is NOT one of those cases.)
    return `## ${name} — memory\n_No code-graph memory generated for this repo yet._`;
  }
  const mtime = newestMtimeMs([
    join(memDir, 'repo.md'),
    join(memDir, 'graph-notes.md'),
    join(memDir, 'doc-notes.md'),
  ]);
  const ageClause = mtime != null ? ` (updated ${relativeAge(mtime)})` : '';
  return `## ${name} — memory${ageClause}\n_(from \`${root}/graphify-out/memory/\`)_\n\n${parts.join('\n\n')}`;
}

export function renderGraphifyMemory(agentContext, userId) {
  const repos = agentContext?.indexedRepos;
  if (!Array.isArray(repos) || repos.length === 0) return '';
  if (!userId) return '';   // no anonymous reads

  // Build the allow-set once (shared helper; see buildAllowedRoots). A user
  // with no registered repos gets an empty set → every repo silently fails the
  // gate; a DB hiccup returns null → fail closed.
  const allowedRoots = buildAllowedRoots(userId);
  if (!allowedRoots || allowedRoots.size === 0) return '';

  const candidates = repos.slice(0, MAX_REPOS);
  const blocks = [];
  let totalUsed = 0;
  for (const repo of candidates) {
    const remaining = TOTAL_CHARS - totalUsed;
    if (remaining <= 500) break;
    const block = repoMemoryBlock(repo, remaining, allowedRoots);
    if (block) {
      blocks.push(block);
      totalUsed += block.length;
    }
  }
  if (blocks.length === 0) return '';

  return ['# Repository memory (Graphify)', ...blocks].join('\n\n');
}
