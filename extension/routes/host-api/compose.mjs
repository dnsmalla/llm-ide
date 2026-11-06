import { clamp } from './frame.mjs';

// Host API v1 chat composition on the desktop host: attachment framing (capability chat) and, from Task 3 of the web
// chat parity plan, the `compose` options. Pure. The v1 wire names an attachment by its file name only; the engine
// (core/prompt-framing.mjs) reads { path, content } and treats `path` as a display label, never a file to open.

/** The wire's attachments as the engine's files; entries without both strings are dropped (the schema already refused them). */
export function attachmentsToFiles(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => typeof a?.name === 'string' && typeof a?.text === 'string')
    .map((a) => ({ path: a.name, content: a.text }));
}

/** The modes a `compose` client may pick; the same list as HOST_TURN_MODES in routes/agent-v2.mjs (tested equal). */
export const COMPOSE_MODES = Object.freeze(['auto', 'ask', 'plan', 'assist_plan', 'review', 'document']);
const MAX_MODELS = 50;
const MODEL_RE = /^[A-Za-z0-9_.:[\]-]{1,200}$/;
/** chat.options from listSdkModels' entries: the account's Claude models, first = the SDK default. */
export function optionsOf(entries) {
  const seen = new Set(); const models = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const id = e?.id;
    if (typeof id !== 'string' || !MODEL_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = clamp(typeof e.displayName === 'string' ? e.displayName.trim() : '', 200);
    models.push({ model: id, ...(label ? { label } : {}) });
    if (models.length === MAX_MODELS) break;
  }
  return { modes: [...COMPOSE_MODES], models };
}
export const offersModel = (entries, id) => optionsOf(entries).models.some((m) => m.model === id);
