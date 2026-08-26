// Writes (and edits) the Code Assistant's auto-captured project memory:
// `<repo>/system/memory/chat-memory.md` (see graphkit/paths.mjs for the full
// layout). This is the WRITE half of the repo-memory loop — memory.mjs reads
// chat-memory.md back into the agent prompt every request, so anything persisted
// here is recalled next turn for free.
//
// Project memory is durable and NEVER auto-deleted by a chat session's
// lifecycle — only the viewer's explicit per-fact edit/delete touches it.
// Session-scoped memory that IS deleted when its session ends lives in a
// separate store (kb/session-memory.mjs, a real DB table) — see
// llm_agent/runtime/memory-persist.mjs, which populates both from the same
// extraction pass. (Before this, project memory carried a session-attribution
// sidecar used to prune it on session delete — removed: that contradicted
// project memory being edit-only, and duplicated what the DB table now does.)
//
// Security: callers MUST pass a `root` already resolved through
// resolveAllowedRepoRoot (memory.mjs) — this module does no path gating itself.
// All disk I/O is best-effort: a read/write error collapses to a safe value
// (empty list / no-op), never throws into the caller.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { config } from '../core/config.mjs';
import {
  chatMemoryFile, legacyChatMemoryFile, memoryDir,
} from './paths.mjs';

// How many facts the store may hold. The reader ranks these against the current
// question and inlines only the most relevant, so this is a disk budget, not a
// per-prompt one.
const MAX_FACTS = config.memory.maxFacts;
// Same value as the reader's chat-memory READ cap (config.memory.chatStoreChars)
// — one source of truth, so the reader can never slice a bullet the writer
// stored. What the reader INJECTS into a prompt is a smaller, relevance-ranked
// subset (config.memory.chatInjectChars), which is what lets this store be big.
const MAX_FILE_CHARS = config.memory.chatStoreChars;
const MAX_FACT_CHARS = 280; // one durable fact, not a paragraph

const HEADER = [
  '# Chat memory',
  '_Auto-captured by the Code Assistant from prior chats about this project._',
  '_Recalled automatically next session. View or clear these in the app._',
  '',
].join('\n');

// The canonical file — see graphkit/paths.mjs. The only path ever WRITTEN.
function memFilePath(root) {
  return chatMemoryFile(root);
}

// `factKey` / `factIndex` moved to core/fact-key.mjs so kb/ (L1) can share the
// same fact identity without importing graphkit (L3). Re-exported here because
// this module and the graphkit barrel are their established import path.
// Imported, not just re-exported: this module calls both internally, and a
// bare `export … from` would not bind them in local scope.
import { factKey, factIndex } from '../core/fact-key.mjs';
export { factKey, factIndex };

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
    const key = factIndex(fact);
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
    const k = factIndex(f);
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
//
// Falls back to the pre-consolidation location when the canonical file doesn't
// exist yet, so facts captured before the move aren't lost on a repo the Mac app
// hasn't regenerated since. The fallback is READ-ONLY — the next write lands at
// the canonical path (and retires the legacy file), so this converges to one
// file after a single turn rather than maintaining two.
export function readChatMemoryFacts(root) {
  try {
    return parseChatMemoryFacts(readFileSync(memFilePath(root), 'utf8'));
  } catch {
    try {
      return parseChatMemoryFacts(readFileSync(legacyChatMemoryFile(root), 'utf8'));
    } catch {
      return [];
    }
  }
}

// Overwrite the file with exactly `facts` (after caps/dedup). Used by the
// viewer's delete/clear. Returns the persisted list. Best-effort → returns the
// intended list even if the write fails (caller treats as advisory).
export function writeChatMemoryFacts(root, facts) {
  const content = renderChatMemoryFile(facts);
  const target = memFilePath(root);
  try {
    mkdirSync(memoryDir(root), { recursive: true });
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
    // The canonical file now holds these facts (including any read forward from
    // the old location), so retire the legacy one. Done only AFTER a successful
    // write, so a failure can never leave the facts nowhere. Removing it is what
    // makes the migration converge — otherwise both files would linger and the
    // stale one would keep shadowing reads for tools that look there.
    const legacy = legacyChatMemoryFile(root);
    if (existsSync(legacy)) {
      try { unlinkSync(legacy); } catch { /* leave it; the canonical file wins on read */ }
    }
  } catch { /* best-effort — a failed write leaves the previous file intact */ }
  return parseChatMemoryFacts(content);
}

// UPSERT new facts into the existing file and drop superseded ones.
//
// `factKey` is the index. A fact whose key is already stored is not a
// duplicate to discard — it's an UPDATE: the new text replaces the stored one
// IN PLACE, keeping its position in the file. Previously the incoming copy was
// dropped, so a fact whose value had changed ("the server binds to :3456" →
// "…:4000") could only ever be corrected via the extractor's `superseded`
// path, and any re-worded restatement was silently thrown away — the stale
// version won forever.
//
// Position is preserved rather than moving an updated fact to the end: it keeps
// the file diff-friendly, and with a store this large (config.memory.maxFacts)
// the newest-wins overflow eviction effectively never fires.
//
// `remove` entries are matched by factKey too — the same normalization the
// index uses — so a paraphrase of a stored fact still removes it. Returns the
// resulting persisted fact list; no-op (returns existing) when nothing was
// added, updated, or removed.
//
// Project memory has no session attribution and is never auto-pruned by a
// session's lifecycle — it's durable, edit-only (see the viewer's per-fact
// delete). Session-scoped, session-deletable memory is a separate store —
// see kb/session-memory.mjs — populated from the SAME extracted facts by
// llm_agent/runtime/memory-persist.mjs.
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

  const merged = [...existing];
  // First occurrence wins as the slot for a key, matching parseChatMemoryFacts'
  // own dedup order for a hand-edited file that contains duplicates.
  const slotByKey = new Map();
  merged.forEach((f, i) => {
    const k = factIndex(f);
    if (k && !slotByKey.has(k)) slotByKey.set(k, i);
  });
  let added = 0;
  let updated = 0;
  for (const fact of incoming) {
    const k = factIndex(fact);
    if (!k) continue;
    const slot = slotByKey.get(k);
    if (slot === undefined) {
      slotByKey.set(k, merged.length);
      merged.push(fact);
      added++;
    } else if (merged[slot] !== fact) {
      merged[slot] = fact;   // same index, new data → update in place
      updated++;
    }
  }

  if (added === 0 && updated === 0 && removedCount === 0) {
    if (meta && typeof meta === 'object') {
      meta.evicted = 0; meta.added = 0; meta.updated = 0; meta.removed = 0;
    }
    return existing; // nothing new, nothing changed, nothing superseded
  }
  const saved = writeChatMemoryFacts(root, merged);
  if (meta && typeof meta === 'object') {
    meta.evicted = Math.max(0, merged.length - saved.length);
    meta.added = added;
    meta.updated = updated;
    meta.removed = removedCount;
  }
  return saved;
}
