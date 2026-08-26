// Fact identity for the memory stores — how "the same fact" is decided when
// new data either replaces an existing row or becomes a new one.
//
// Lives in core/ rather than beside its main consumer (graphkit/memory-writer)
// because BOTH the file-based project memory (L3 graphkit) and the SQLite
// session memory (L1 kb) key on it, and kb/ may not import graphkit/. Pure
// string functions with no dependencies — same pattern as core/redact-object.
// `graphkit/memory-writer.mjs` re-exports these so existing importers and the
// graphkit barrel keep working.

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

// The UPSERT INDEX for a stored fact — what "the same fact" means when deciding
// whether new data replaces an old row or becomes a new one.
//
// `factKey` alone can't answer that, because it keys on the whole sentence: a
// fact whose VALUE changed ("binds to port 3456" → "binds to port 4000") gets a
// different factKey and lands as a second, contradictory row. So a fact may
// carry an explicit subject id in its tag — `[category|subject-id] text` — and
// when it does, THAT is the index: same subject id ⇒ same fact ⇒ update in
// place. The extractor is asked to reuse a known fact's id when it revises it
// (see llm_agent/runtime/memory-extract.mjs).
export function factIndex(s) {
  const tag = /^\s*\[([^\]]+)\]/.exec(String(s));
  if (tag) {
    const bar = tag[1].indexOf('|');
    if (bar >= 0) {
      const id = tag[1].slice(bar + 1).trim().toLowerCase();
      if (id) return `#${id}`;   // `#` namespaces ids so one can't collide with a text key
    }
  }
  return factKey(s);
}
