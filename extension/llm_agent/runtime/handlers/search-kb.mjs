// Read handler: search the user's KB (meetings, decisions, action
// items, sources). Server-executed inside the loop — result is fed
// back to the agent as a <<<TOOL_RESULT>>> block.
//
// `ctx.kb.search(userId, { q, kind, limit })` returns an array of
// hits, each shaped roughly { kind, id, title, snippet }.

// Fence redaction lives in ../redaction.mjs; re-exported here for
// backward compatibility with existing importers and tests.
import { redactFence } from '../redaction.mjs';
export { redactFence };

export async function searchKb(args, ctx) {
  const raw = await Promise.resolve(ctx.kb.search(ctx.userId, {
    q: args.query,
    kind: null,
    limit: 10,
  }));
  const list = Array.isArray(raw) ? raw : [];
  // kb.search rows (db.mjs hydrateSearchRows) carry `entityId`/`meetingId`,
  // the chunk text in `body`, and a code chunk's location in `meta`.
  const hits = list.slice(0, 10).map((h) => {
    const id = h.entityId ?? h.meetingId;
    const hit = {
      kind: redactFence(h.kind),
      id: id != null ? redactFence(String(id)) : '',
      title: redactFence(h.title || ''),
      snippet: redactFence(snippetFor(h.body, args.query)),
    };
    if (typeof h.meta?.relPath === 'string') {
      hit.path = redactFence(h.meta.relPath);
      if (Number.isInteger(h.meta.startLine)) hit.line = h.meta.startLine;
    }
    return hit;
  });
  return { hits, truncated: list.length > 10 };
}

const SNIPPET_CHARS = 360;

/**
 * A bounded excerpt of `body`, centred on the first query term it contains
 * (case-insensitive), else its head. A whole chunk is up to 80 lines — far
 * more than a ranked list needs; the agent reads the file for the rest.
 */
export function snippetFor(body, query) {
  if (typeof body !== 'string' || !body) return '';
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= SNIPPET_CHARS) return text;
  const lower = text.toLowerCase();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return `${text.slice(0, SNIPPET_CHARS)}…`;
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
