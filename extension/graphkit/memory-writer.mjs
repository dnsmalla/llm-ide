// Writes (and edits) the Code Assistant's auto-captured project memory:
// `<repo>/graphify-out/memory/chat-memory.md`. This is the WRITE half of the
// Graphify-memory loop — memory.mjs reads chat-memory.md back into the agent
// prompt every request, so anything persisted here is recalled next turn for
// free.
//
// Security: callers MUST pass a `root` already resolved through
// resolveAllowedRepoRoot (memory.mjs) — this module does no path gating itself.
// All disk I/O is best-effort: a read/write error collapses to a safe value
// (empty list / no-op), never throws into the caller.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/config.mjs';

// Caps mirror the reader's per-file budget (PER_FILE_CHARS = 4000 there); we
// keep the on-disk file comfortably under that so it's never truncated mid-read.
const MAX_FACTS = config.memory.maxFacts;
// Same value as the reader's chat-memory cap (config.memory.chatFileChars) —
// one source of truth so the writer never stores more than the reader injects.
const MAX_FILE_CHARS = config.memory.chatFileChars;
const MAX_FACT_CHARS = 280; // one durable fact, not a paragraph

const HEADER = [
  '# Chat memory',
  '_Auto-captured by the Code Assistant from prior chats about this project._',
  '_Recalled automatically next session. View or clear these in the app._',
  '',
].join('\n');

function memFilePath(root) {
  return join(root, 'graphify-out', 'memory', 'chat-memory.md');
}

// Leading filler the extractor commonly varies between restatements of the
// SAME fact — "uses X" vs "the project uses X" vs "this repo uses X". Two facts
// that differ ONLY by this glue are the same fact, so folding it into the dedup
// key stops paraphrases from accumulating and FIFO-evicting a real fact. Kept
// deliberately tiny (articles/pronouns + project/repo lead-ins) so it can't
// merge facts that differ in substance.
const LEAD_DETERMINER_RE = /^(?:the|a|an|this|that|these|those|our|we|it|its|their)\s+/;
const LEAD_SUBJECT_RE = /^(?:project|repo|repository|codebase|app|application)\s+/;

// Normalised key for dedup: strip a leading `[category]` tag, collapse inner
// whitespace, lowercase, then peel a bounded run of leading filler. Keying on
// the fact TEXT (not its category) means the same fact never re-enters under a
// different tag; peeling filler means an obvious paraphrase doesn't either.
// Exported for unit testing.
export function factKey(s) {
  let k = String(s).trim().replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').toLowerCase();
  for (let i = 0; i < 3; i++) {                 // bounded: at most a few glue words
    const next = k.replace(LEAD_DETERMINER_RE, '');
    if (next === k) break;
    k = next;
  }
  k = k.replace(LEAD_SUBJECT_RE, '');           // one optional "project/repo …" lead-in
  return k.trim();
}

// Pull the `- ` bullet lines out of the markdown body. Pure + exported so the
// viewer endpoint and tests can parse a file's content without disk I/O.
export function parseChatMemoryFacts(content) {
  if (typeof content !== 'string' || !content) return [];
  const out = [];
  const seen = new Set();
  for (const raw of content.split('\n')) {
    const m = /^\s*-\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const fact = m[1].trim();
    if (!fact) continue;
    const key = factKey(fact);
    if (seen.has(key)) continue; // a file edited by hand may have dupes
    seen.add(key);
    out.push(fact);
  }
  return out;
}

// Render a complete chat-memory.md from a fact list (header + bullets), with
// caps applied: newest facts win when over MAX_FACTS, and the whole file is
// kept under MAX_FILE_CHARS by dropping from the oldest end. Pure + exported.
export function renderChatMemoryFile(facts) {
  let list = (Array.isArray(facts) ? facts : [])
    .map((f) => String(f).trim().slice(0, MAX_FACT_CHARS))
    .filter(Boolean);
  // Dedup (keep first occurrence) then keep the NEWEST MAX_FACTS.
  const seen = new Set();
  list = list.filter((f) => {
    const k = factKey(f);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (list.length > MAX_FACTS) list = list.slice(list.length - MAX_FACTS);
  // Char cap: keep the newest contiguous run of facts that fits, found in one
  // backward pass (avoids repeatedly re-joining the whole list per dropped
  // fact, which was O(n^2) once MAX_FACTS grew past a few hundred).
  const budget = MAX_FILE_CHARS - HEADER.length;
  let keepFrom = list.length;
  if (list.length > 0) {
    keepFrom = list.length - 1;
    let total = list[keepFrom].length + 2;
    for (let i = keepFrom - 1; i >= 0; i--) {
      const added = list[i].length + 2 + 1; // "- " prefix + joining newline
      if (total + added > budget) break;
      total += added;
      keepFrom = i;
    }
  }
  list = list.slice(keepFrom);
  const body = list.map((f) => `- ${f}`).join('\n');
  return list.length ? `${HEADER}${body}\n` : '';
}

// Read the current fact list for a repo. Best-effort → [] on any error.
export function readChatMemoryFacts(root) {
  try {
    return parseChatMemoryFacts(readFileSync(memFilePath(root), 'utf8'));
  } catch {
    return [];
  }
}

// Overwrite the file with exactly `facts` (after caps/dedup). Used by the
// viewer's delete/clear. Returns the persisted list. Best-effort → returns the
// intended list even if the write fails (caller treats as advisory).
export function writeChatMemoryFacts(root, facts) {
  const content = renderChatMemoryFile(facts);
  const target = memFilePath(root);
  try {
    mkdirSync(join(root, 'graphify-out', 'memory'), { recursive: true });
    // Atomic write: write to a temp file in the SAME directory (so the rename
    // stays on one filesystem and is atomic), then rename over the target. A
    // crash mid-write can only leave the temp file — never a half-written
    // chat-memory.md that the reader would then parse as truncated facts. The
    // temp name carries the pid so a second server process writing the same
    // repo can't clobber our temp; writes within one process are synchronous
    // and sequential, so a fixed pid suffix can't collide with itself.
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, target);
    } catch (err) {
      // Best-effort cleanup so a failed write doesn't leak the temp file.
      try { unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
  } catch { /* best-effort — a failed write leaves the previous file intact */ }
  return parseChatMemoryFacts(content);
}

// Merge new facts into the existing file (dedup against what's there, newest
// kept on overflow) and drop superseded facts. `remove` entries are matched
// by factKey — the same normalization dedup uses, so a paraphrase of a stored
// fact still removes it. Returns the resulting persisted fact list. No-op
// (returns existing) when there's nothing to add AND nothing to remove.
export function appendChatMemory({ root, facts, remove, meta }) {
  const incoming = (Array.isArray(facts) ? facts : [])
    .map((f) => String(f).trim())
    .filter(Boolean);
  const removeKeys = new Set((Array.isArray(remove) ? remove : [])
    .map((f) => factKey(f))
    .filter(Boolean));
  let existing = readChatMemoryFacts(root);
  let removedCount = 0;
  if (removeKeys.size > 0) {
    const before = existing.length;
    existing = existing.filter((f) => !removeKeys.has(factKey(f)));
    removedCount = before - existing.length;
  }
  const have = new Set(existing.map(factKey));
  const fresh = incoming.filter((f) => !have.has(factKey(f)));
  if (fresh.length === 0 && removedCount === 0) {
    if (meta && typeof meta === 'object') { meta.evicted = 0; meta.added = 0; meta.removed = 0; }
    return existing; // nothing genuinely new, nothing superseded
  }
  const candidates = [...existing, ...fresh];
  const saved = writeChatMemoryFacts(root, candidates);
  if (meta && typeof meta === 'object') {
    meta.evicted = Math.max(0, candidates.length - saved.length);
    meta.added = Math.max(0, saved.length - existing.length);
    meta.removed = removedCount;
  }
  return saved;
}
