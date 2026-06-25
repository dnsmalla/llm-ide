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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Caps mirror the reader's per-file budget (PER_FILE_CHARS = 4000 there); we
// keep the on-disk file comfortably under that so it's never truncated mid-read.
const MAX_FACTS = 100;
const MAX_FILE_CHARS = 8_000;
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

// Normalised key for dedup: trim, collapse inner whitespace, lowercase.
function factKey(s) {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
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
  // Char cap: drop oldest until under budget.
  let body = list.map((f) => `- ${f}`).join('\n');
  while (list.length > 1 && (HEADER.length + body.length) > MAX_FILE_CHARS) {
    list = list.slice(1);
    body = list.map((f) => `- ${f}`).join('\n');
  }
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
  try {
    mkdirSync(join(root, 'graphify-out', 'memory'), { recursive: true });
    writeFileSync(memFilePath(root), content, 'utf8');
  } catch { /* best-effort */ }
  return parseChatMemoryFacts(content);
}

// Merge new facts into the existing file (dedup against what's there, newest
// kept on overflow). Returns the resulting persisted fact list. No-op (returns
// existing) when there's nothing new to add.
export function appendChatMemory({ root, facts }) {
  const incoming = (Array.isArray(facts) ? facts : [])
    .map((f) => String(f).trim())
    .filter(Boolean);
  const existing = readChatMemoryFacts(root);
  if (incoming.length === 0) return existing;
  const have = new Set(existing.map(factKey));
  const fresh = incoming.filter((f) => !have.has(factKey(f)));
  if (fresh.length === 0) return existing; // nothing genuinely new
  return writeChatMemoryFacts(root, [...existing, ...fresh]);
}
