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
  const hits = list.slice(0, 10).map((h) => ({
    kind: redactFence(h.kind),
    id: h.id != null ? redactFence(String(h.id)) : '',
    title: redactFence(h.title || ''),
    snippet: redactFence(h.snippet || ''),
  }));
  return { hits, truncated: list.length > 10 };
}
