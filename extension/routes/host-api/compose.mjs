// Host API v1 chat composition on the desktop host: attachment framing (capability chat) and, from Task 3 of the web
// chat parity plan, the `compose` options. Pure. The v1 wire names an attachment by its file name only; the engine
// (core/prompt-framing.mjs) reads { path, content } and treats `path` as a display label, never a file to open.

/** The wire's attachments as the engine's files; entries without both strings are dropped (the schema already refused them). */
export function attachmentsToFiles(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => typeof a?.name === 'string' && typeof a?.text === 'string')
    .map((a) => ({ path: a.name, content: a.text }));
}
