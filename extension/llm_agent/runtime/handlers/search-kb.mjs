// Read handler: search the user's KB (meetings, decisions, action
// items, sources). Server-executed inside the loop — result is fed
// back to the agent as a <<<TOOL_RESULT>>> block.
//
// `ctx.kb.search(userId, { q, kind, limit })` returns an array of
// hits, each shaped roughly { kind, id, title, snippet }.

// Fence redaction lives in ../redaction.mjs; re-exported here for
// backward compatibility with existing importers and tests.
import { redactFence } from '../redaction.mjs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPathCase } from '../../../core/path-case.mjs';
export { redactFence };

const PAGE = 10;
// Fetched when scoping to a workspace, so dropping other repos' code still
// leaves a full page. Code rows carry no project tag and one user's index
// holds every repo they ever opened (clones of the same repo included).
const SCOPED_FETCH = 40;

export async function searchKb(args, ctx) {
  const root = typeof ctx.workspaceRoot === 'string' && ctx.workspaceRoot.trim()
    ? canonicalPathCase(expandHome(ctx.workspaceRoot.trim()))
    : null;
  const raw = await Promise.resolve(ctx.kb.search(ctx.userId, {
    q: args.query,
    kind: null,
    limit: root ? SCOPED_FETCH : PAGE,
  }));
  const all = Array.isArray(raw) ? raw : [];
  // Only CODE refs are filesystem paths; a doc's ref may be a URL (Box), and
  // meetings have none — those are not the workspace's to filter.
  const list = root
    ? all.filter((h) => h.kind !== 'code' || isUnder(String(h.ref || ''), root))
    : all;
  // kb.search rows (db.mjs hydrateSearchRows) carry `entityId`/`meetingId`,
  // the chunk text in `body`, and a code chunk's location in `meta`.
  const hits = list.slice(0, PAGE).map((h) => {
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
  return { hits, truncated: list.length > PAGE };
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

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

// `ref` is a chunk's absolute file path; compared in on-disk letter case so a
// workspace opened as ~/Desktop/llm still matches rows indexed as …/LLM.
function isUnder(ref, root) {
  const abs = canonicalPathCase(ref);
  return abs === root || abs.startsWith(root + path.sep);
}
