// Fence-sentinel redaction — the prompt-injection defense shared by the
// loop engine and every handler that embeds external text into a prompt.
//
// Neutralise fence sentinels (`<<<` / `>>>`) in user-supplied text so
// that a malicious meeting title or issue snippet cannot escape the
// `<<<TOOL_RESULT>>>...<<<END_TOOL_RESULT>>>` fence and inject a forged
// `<<<TOOL_CALL>>>` block. Insert a zero-width joiner between the
// brackets — visually identical but no longer a parseable sentinel.
//
// Lives in its own module (rather than inside a handler) because a
// change to the redaction strategy must apply everywhere at once;
// loop.mjs, search-kb, ask-internal, and ask-subagent all import this.

const ZWJ = '‍';

export function redactFence(s) {
  if (typeof s !== 'string') return s;
  return s.replaceAll('<<<', `<<${ZWJ}<`).replaceAll('>>>', `>${ZWJ}>>`);
}
