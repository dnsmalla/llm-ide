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
import { config } from '../core/config.mjs';
import { parseChatMemoryFacts } from './memory-writer.mjs';

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

const PER_FILE_CHARS = config.memory.perFileChars;
// chat-memory.md is written up to config.memory.chatFileChars (the SAME value
// the writer caps the file at), so read it at that full cap rather than
// PER_FILE_CHARS — otherwise every curated fact past the first ~4 KB was
// silently dropped before it reached the agent. The shared TOTAL_CHARS budget
// below still bounds the whole block.
const CHAT_MEMORY_CHARS = config.memory.chatFileChars;
const TOTAL_CHARS = config.memory.totalChars;
const MAX_BUG_FILES = 8;
const MAX_QA_FILES = 8;
// Cap the number of repos whose memory we inline. The list comes from
// agentContext.indexedRepos but Graphify memory is heavy — surfacing
// more than two repos at once dilutes the signal and bloats the prompt.
const MAX_REPOS = config.memory.maxRepos;

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

// A client-supplied workspace root is trusted for memory ONLY if it's a sane
// project root: absolute, no `..`, and not over-broad ('/' or $HOME). Same
// posture as repo-files.mjs — the user explicitly opened it, but reads/writes
// still stay rooted under it (resolveAllowedRepoRoot collapses `..`).
function isSafeWorkspaceRoot(p) {
  if (typeof p !== 'string' || !p) return false;
  const expanded = expandTilde(p);
  if (expanded.split(/[/\\]/).includes('..')) return false;
  if (!isAbsolute(expanded)) return false;
  const real = resolve(normalize(expanded));
  if (real === '/' || real === resolve(normalize(homedir()))) return false;
  if (real.split(/[/\\]/).filter(Boolean).length <= 1) return false;
  return true;
}

// Build the per-user allow-set, normalised the same way resolveAllowedRepoRoot
// normalises candidate paths, so the .has() comparison is symmetric. Includes
// the DB repo allow-list (trusted) plus the open workspace folder when given
// (client-supplied but validated by isSafeWorkspaceRoot) so project memory
// works for the folder the user has open even when it isn't formally indexed.
// A user with no registered repos and no workspace gets an empty set → every
// repo fails the gate. Returns null on a DB error with no usable workspace
// fallback, so callers can fail closed.
export function buildAllowedRoots(userId, workspaceRoot) {
  if (!userId) return null;
  const set = new Set();
  try {
    for (const p of userRepoAllowlist(userId)) {
      // Expand tilde defensively in case a legacy allow-list entry is home-relative.
      if (typeof p === 'string' && p) set.add(normalizeForCompare(resolve(normalize(expandTilde(p)))));
    }
  } catch {
    // DB hiccup — a valid workspace root can still seed the set; otherwise fail closed.
    if (!isSafeWorkspaceRoot(workspaceRoot)) return null;
  }
  if (isSafeWorkspaceRoot(workspaceRoot)) {
    set.add(normalizeForCompare(resolve(normalize(expandTilde(workspaceRoot)))));
  }
  return set;
}

// Truncate `text` to at most `room` chars WITHOUT cutting a line mid-way, so a
// memory fact / bullet is never split mid-sentence. Slice to room, then back
// up to the last newline — but only if that boundary keeps a reasonable amount
// (>60% of room); otherwise the content is one long line and a hard cut is the
// best we can do. Pure + exported for unit tests.
export function clipToBoundary(text, room) {
  if (text.length <= room) return text;
  const head = text.slice(0, room);
  const nl = head.lastIndexOf('\n');
  const body = nl > room * 0.6 ? head.slice(0, nl) : head;
  return `${body.trimEnd()}\n…(truncated)`;
}

// Tiny stopword set so query tokens like "how"/"the"/"does" don't create
// spurious overlap with every fact. Not exhaustive — just the high-frequency
// English glue words that would otherwise dominate the score.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'how', 'does', 'what', 'are',
  'you', 'can', 'why', 'when', 'where', 'which', 'was', 'were', 'has', 'have',
  'our', 'use', 'used', 'using', 'from', 'into', 'about', 'they', 'them',
]);

function queryTokens(userMessage) {
  if (typeof userMessage !== 'string') return new Set();
  const toks = userMessage.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
  return new Set(toks.filter((t) => !STOPWORDS.has(t)));
}

// Rank chat-memory facts by relevance to the current question and greedily pack
// the ones that fit `room`, most-relevant first. Score = number of distinct
// query tokens the fact (text + [category] tag) contains; ties break toward the
// NEWER fact (facts arrive oldest->newest, so a higher index is newer). With no
// query tokens, this degrades to pure newest-first — which already fixes the
// old raw-clip that kept the OLDEST facts and dropped the newest. Pure +
// exported for unit tests. Returns a `- fact` bullet body (no header), or ''.
export function selectChatMemoryFacts(content, { userMessage = '', room = 0 } = {}) {
  const facts = parseChatMemoryFacts(content);
  if (facts.length === 0 || room <= 0) return '';
  const q = queryTokens(userMessage);
  const scored = facts.map((fact, i) => {
    let score = 0;
    if (q.size > 0) {
      const factToks = new Set((fact.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []));
      for (const t of q) if (factToks.has(t)) score += 1;
    }
    return { fact, score, index: i };
  });
  // Most relevant first; newer wins ties (higher original index).
  scored.sort((a, b) => (b.score - a.score) || (b.index - a.index));
  const chosen = [];
  let used = 0;
  for (const { fact } of scored) {
    const line = `- ${fact}`;
    const cost = line.length + (chosen.length > 0 ? 1 : 0); // +1 for the joining newline
    if (used + cost > room) continue;   // skip; a later shorter fact may still fit
    chosen.push(line);
    used += cost;
  }
  // `chosen` is already in relevance order (scored is sorted), so the agent
  // sees the most relevant facts first.
  return chosen.join('\n');
}

function repoMemoryBlock(repo, budget, allowedRoots, stats, userMessage) {
  if (!repo) return null;
  const root = resolveAllowedRepoRoot(repo.path, allowedRoots);
  if (!root) return null;
  const memDir = join(root, 'graphify-out', 'memory');
  const repoName = repo.name || 'Repository';

  const parts = [];
  let used = 0;
  // `maxRoom` optionally caps how much of the remaining budget one file may
  // take, so a fat earlier file can't starve a reserved-floor file added later.
  const tryAdd = (label, body, maxRoom = Infinity) => {
    if (!body) return;
    const trimmed = body.trim();
    if (!trimmed) return;
    const room = Math.min(budget - used, maxRoom);
    if (room <= 200) return; // not worth a header for a tiny remainder
    const clipped = clipToBoundary(trimmed, room);
    parts.push(`### ${label}\n${clipped}`);
    used += clipped.length + label.length + 6;
    // Observability: record what actually reached the agent (file, injected
    // size, and whether it was truncated to fit the budget). Optional — only
    // populated when the caller passes a `stats` sink.
    if (Array.isArray(stats)) {
      stats.push({ repo: repoName, file: label, chars: clipped.length, truncated: clipped !== trimmed });
    }
  };

  // chat-memory.md is the LLM-CURATED half (conventions/decisions the assistant
  // learned) — the highest-signal, hardest-to-regenerate content. Select the
  // facts most relevant to THIS question and reserve a budget FLOOR for them so
  // a fat repo.md can't crowd them out (the old order added repo.md first with
  // the full budget, starving chat-memory within — and across — repos).
  const chatBody = selectChatMemoryFacts(
    safeRead(join(memDir, 'chat-memory.md'), CHAT_MEMORY_CHARS),
    { userMessage, room: Math.min(budget, CHAT_MEMORY_CHARS) },
  );
  const chatFloor = Math.min(Math.floor(budget * 0.5), chatBody.length);

  // Order = priority: the memory budget is fixed, so add the highest-signal,
  // most token-efficient content FIRST. repo.md is the impact-ranked repo
  // overview — added first, but capped so it leaves `chatFloor` for the curated
  // facts. The bulkier graph/doc prose comes after, so it's what gets clipped.
  tryAdd('repo.md', safeRead(join(memDir, 'repo.md'), PER_FILE_CHARS), budget - chatFloor);
  // Auto-captured facts the Code Assistant learned in prior chats about this
  // project (written by memory-writer.mjs after each turn). Same dir, same
  // gate — recall is free because this reader already runs every request.
  tryAdd('chat-memory.md', chatBody);
  tryAdd('graph-notes.md', safeRead(join(memDir, 'graph-notes.md'), PER_FILE_CHARS));
  tryAdd('doc-notes.md', safeRead(join(memDir, 'doc-notes.md'), PER_FILE_CHARS));

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

export function renderGraphifyMemory(agentContext, userId, stats, userMessage = '') {
  if (!userId) return '';   // no anonymous reads
  const indexed = Array.isArray(agentContext?.indexedRepos) ? agentContext.indexedRepos : [];
  const wsRoot = agentContext?.workspaceRoot;

  // Candidates: the indexed repos plus the open workspace folder, so a project
  // that isn't formally indexed still gets project memory. Workspace goes last
  // so an indexed repo wins when both resolve to memory.
  const rawCandidates = [...indexed];
  if (typeof wsRoot === 'string' && wsRoot) rawCandidates.push({ name: 'Workspace', path: wsRoot });
  if (rawCandidates.length === 0) return '';

  // Build the allow-set once (shared helper; see buildAllowedRoots). DB allow-
  // list plus the validated workspace root. Empty set / null → fail closed.
  const allowedRoots = buildAllowedRoots(userId, wsRoot);
  if (!allowedRoots || allowedRoots.size === 0) return '';

  // Dedup by resolved path so the workspace folder doesn't double-render when
  // it's also an indexed repo.
  const seen = new Set();
  const candidates = [];
  for (const c of rawCandidates) {
    if (!c?.path) continue;
    const key = normalizeForCompare(resolve(normalize(expandTilde(c.path))));
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
    if (candidates.length >= MAX_REPOS) break;
  }
  const blocks = [];
  let totalUsed = 0;
  for (const repo of candidates) {
    const remaining = TOTAL_CHARS - totalUsed;
    if (remaining <= 500) break;
    const block = repoMemoryBlock(repo, remaining, allowedRoots, stats, userMessage);
    if (block) {
      blocks.push(block);
      totalUsed += block.length;
    }
  }
  if (blocks.length === 0) return '';

  return ['# Repository memory (Graphify)', ...blocks].join('\n\n');
}
