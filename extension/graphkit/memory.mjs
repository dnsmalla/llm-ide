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

function repoMemoryBlock(repo, budget, allowedRoots) {
  if (!repo || typeof repo.path !== 'string' || !repo.path) return null;
  // The Mac client sends home-relative paths ("~/…"); expand to absolute.
  const expanded = expandTilde(repo.path);
  // Defense-in-depth: reject an unresolved parent-traversal segment. (resolve()
  // collapses it and the allow-list gates the result anyway, but fail fast.)
  if (expanded.split(/[/\\]/).includes('..')) return null;
  // Only honor absolute paths post-expansion. A still-relative path would be
  // ambiguous server-side.
  if (!isAbsolute(expanded)) return null;
  // Tenancy gate: the path must be in the user's registered repo
  // allow-list. agentContext.indexedRepos is client-supplied, so a
  // hostile or buggy client could otherwise drive the server to read
  // arbitrary `<x>/graphify-out/memory/repo.md` files. resolve() is
  // applied to both sides so `/foo/../bar` and `/bar` compare equal.
  // Pass through normalizeForCompare so APFS case-variants match.
  const root = resolve(normalize(expanded));
  if (!allowedRoots.has(normalizeForCompare(root))) return null;
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

  if (parts.length === 0) return null;
  return `## ${repo.name || 'Repository'} — memory\n_(from \`${root}/graphify-out/memory/\`)_\n\n${parts.join('\n\n')}`;
}

export function renderGraphifyMemory(agentContext, userId) {
  const repos = agentContext?.indexedRepos;
  if (!Array.isArray(repos) || repos.length === 0) return '';
  if (!userId) return '';   // no anonymous reads

  // Build the allow-set once, normalised the same way repo paths are
  // normalised inside repoMemoryBlock, so the .has() comparison is
  // symmetric. A user with no registered repos gets an empty set →
  // every repo silently fails the gate.
  let allowedRoots;
  try {
    allowedRoots = new Set(
      userRepoAllowlist(userId)
        .filter((p) => typeof p === 'string' && p)
        // Same normalisation both sides — see normalizeForCompare. Expand
        // tilde defensively in case a legacy allow-list entry is home-relative.
        .map((p) => normalizeForCompare(resolve(normalize(expandTilde(p))))),
    );
  } catch {
    // DB hiccup — fail closed.
    return '';
  }
  if (allowedRoots.size === 0) return '';

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
