// Local-repo connector — walks a directory and ingests every text file
// it can read into the KB as `kind=code` rows.  Designed to be cheap:
// skips binaries, common build dirs, and files larger than a threshold.
//
// Phase 3 keeps chunking simple (line-based windows).  Phase 4 will swap
// in a tree-sitter-aware chunker when the planning agent needs more
// structural context — the public surface here stays the same.

import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ingestSources, deleteSourcesByRef, sourceContentHashes, getDb, MAX_INGEST_BATCH,
} from '../kb/db.mjs';

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.md', '.mdx', '.txt', '.rst',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.sql', '.sh', '.bash', '.zsh',
  '.html', '.css', '.scss', '.vue', '.svelte',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  '__pycache__', '.venv', 'venv', 'env', 'target', 'out',
  '.DS_Store', '.cache', 'coverage', '.pytest_cache',
]);

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 200 * 1024;       // 200 KB — skip large generated files
const CHUNK_LINES = 80;                  // lines per chunk
const MAX_CHUNKS_PER_FILE = 20;          // hard cap so megafiles can't blow KB
const MAX_DEPTH = 100;                   // prevent infinite loops via very deep trees

export function isProbablyBinary(buf, sample = 4096) {
  // Cheap heuristic: presence of a NUL byte in the first ~4 KB.
  const len = Math.min(buf.length, sample);
  for (let i = 0; i < len; i += 1) if (buf[i] === 0) return true;
  return false;
}

// Async generator — uses fs/promises so a large repo doesn't block
// the event loop for seconds. Previously every readdirSync stalled
// the entire server (auth, /health, SSE pumps) for the duration of
// the walk; on a deep repo that meant noticeable hiccups for other
// users sharing the same Node process.
async function* walkAsync(root) {
  const absRoot = path.resolve(root);
  // Stack entries are [dirPath, depth] pairs so we can enforce MAX_DEPTH.
  const stack = [[absRoot, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    if (depth > MAX_DEPTH) continue;     // prevent runaway recursion
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;                          // permission denied → skip
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      // Never follow symlinks — a symlink inside a repo can point
      // anywhere on the filesystem.  We check explicitly so a platform
      // where isFile()/isDirectory() follows symlinks doesn't silently
      // traverse out of the repo root.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      // Containment check: ensure the resolved path is still inside absRoot.
      // path.join alone doesn't prevent a crafted entry.name with '..'
      // sequences from escaping the root on some platforms or edge cases.
      const normalized = path.resolve(full);
      if (!normalized.startsWith(absRoot + path.sep) && normalized !== absRoot) continue;
      if (entry.isDirectory()) {
        stack.push([full, depth + 1]);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

// The files git would consider part of the work tree at `dir` — tracked plus
// untracked, minus everything .gitignore excludes — as absolute paths, or
// null when `dir` is not in a git work tree (or git is unavailable), so the
// caller falls back to the plain walk.
async function gitListedFiles(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
    });
    return stdout.split('\0').filter(Boolean).map((rel) => path.join(dir, rel));
  } catch {
    return null;
  }
}

// walkAsync's contract (absolute file paths under `root`, no symlinks, no
// hidden segments, contained in `root`) with the file list taken from git
// when `root` is in a work tree. A nested repository is listed by git as one
// `dir/` entry; it is expanded the same way, recursively.
async function* gitAwareWalk(root, depth = 0) {
  const absRoot = path.resolve(root);
  const listed = depth > MAX_DEPTH ? null : await gitListedFiles(absRoot);
  if (!listed) { yield* walkAsync(absRoot); return; }
  for (const full of listed) {
    const rel = path.relative(absRoot, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rel.split(path.sep).some((seg) => (seg.startsWith('.') && seg !== '.env.example') || SKIP_DIRS.has(seg))) continue;
    if (full.endsWith(path.sep)) { yield* gitAwareWalk(full, depth + 1); continue; }
    let st;
    try { st = await fsp.lstat(full); } catch { continue; }   // tracked but deleted
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { yield* gitAwareWalk(full, depth + 1); continue; }
    if (st.isFile()) yield full;
  }
}

export function chunkLines(text) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; i += CHUNK_LINES) {
    chunks.push({
      startLine: i + 1,
      endLine: Math.min(i + CHUNK_LINES, lines.length),
      body: lines.slice(i, i + CHUNK_LINES).join('\n'),
    });
  }
  return chunks;
}

export async function indexLocalRepo(userId, repoPath, opts = {}) {
  const absRoot = path.resolve(repoPath);
  let stat;
  try {
    stat = await fsp.stat(absRoot);
  } catch (err) {
    throw new Error(`Cannot access ${absRoot}: ${err.message}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absRoot}`);
  }

  const replace = opts.replace !== false;
  const walk = typeof opts.walk === 'function' ? opts.walk : gitAwareWalk;

  // Incremental: each file's rows carry its content hash, so a re-index
  // rewrites only files whose bytes changed (and removes deleted ones) instead
  // of wiping and re-inserting the whole repo — every chunk was thousands of
  // FTS writes under the only writer, and a fresh id, on every project open.
  const prefix = `${absRoot}${path.sep}`;
  const known = replace ? sourceContentHashes(userId, 'code', prefix) : new Map();
  const seen = new Set();
  const changedRefs = [];
  const items = [];
  let filesScanned = 0;
  let filesIndexed = 0;
  let unchanged = 0;

  for await (const filePath of walk(absRoot)) {
    filesScanned += 1;
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let stats;
    try { stats = await fsp.stat(filePath); } catch { continue; }
    if (stats.size > MAX_FILE_BYTES) continue;
    let buf;
    try { buf = await fsp.readFile(filePath); } catch { continue; }
    if (isProbablyBinary(buf)) continue;
    seen.add(filePath);
    const contentHash = createHash('sha1').update(buf).digest('hex');
    if (known.get(filePath) === contentHash) { unchanged += 1; filesIndexed += 1; continue; }
    changedRefs.push(filePath);
    const text = buf.toString('utf8');
    const rel = path.relative(absRoot, filePath);
    const chunks = chunkLines(text);
    chunks.forEach((c, idx) => {
      items.push({
        kind: 'code',
        ref: filePath,
        chunkIdx: idx,
        title: `${rel}:${c.startLine}-${c.endLine}`,
        body: c.body,
        meta: {
          repo: absRoot,
          relPath: rel,
          ext,
          startLine: c.startLine,
          endLine: c.endLine,
          contentHash,
        },
      });
    });
    filesIndexed += 1;
  }

  // All writes in ONE transaction, after the walk has finished: deleting first
  // and walking asynchronously meant an error or crash mid-walk left the repo
  // with no code index at all. Refs are absolute paths, so two different roots
  // don't clobber each other.
  const removedRefs = [...known.keys()].filter((ref) => !seen.has(ref));
  const written = getDb().transaction(() => {
    if (replace) {
      for (const ref of changedRefs) deleteSourcesByRef(userId, 'code', ref);
      for (const ref of removedRefs) deleteSourcesByRef(userId, 'code', ref);
    }
    // ingestSources caps a single call; slice inside the same transaction.
    let total = 0;
    for (let i = 0; i < items.length; i += MAX_INGEST_BATCH) {
      total += ingestSources(userId, items.slice(i, i + MAX_INGEST_BATCH));
    }
    return total;
  })();
  // filesIndexed keeps its meaning (files now in the index); filesWritten is
  // how many of them this run actually rewrote.
  return {
    repo: absRoot, filesScanned, filesIndexed, filesWritten: changedRefs.length, unchanged,
    removed: replace ? removedRefs.length : 0, chunks: written,
  };
}
