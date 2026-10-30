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

// The implementation now lives in core/utils.mjs as neutralizePromptFences,
// so this module and sanitizeForPrompt cannot drift apart — which is exactly
// what the paragraph above warns against, and what did happen: the prompt
// path was deleting whole `<<<TOKEN>>>` markers, which nested markers could
// splice back into live sentinels, while this module's neutralising approach
// was immune the whole time.
//
// The non-string passthrough is kept here rather than adopting core's
// empty-string coercion: callers of redactFence pass values through
// unchanged (`redactFence(undefined)` must stay `undefined`), whereas
// sanitizeForPrompt's contract is "always a string".
import { neutralizePromptFences } from '../../core/utils.mjs';

export function redactFence(s) {
  if (typeof s !== 'string') return s;
  return neutralizePromptFences(s);
}
