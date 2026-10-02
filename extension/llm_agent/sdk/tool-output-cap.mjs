// Trims oversized NATIVE tool output (Bash / Grep) before the model sees it —
// a PostToolUse hook's `updatedToolOutput`.
//
// Why: every hop of an agent turn re-reads the whole context, so one huge
// command or search result is paid for again on every later hop of the turn
// and every later turn of the chat (measured on real turns: 147k–895k cached
// tokens re-read per work turn). Each trim says how to get the rest.
//
// Shape-preserving: the result is the same output object with only its text
// fields shortened, so the SDK validates and renders it exactly as before.
//   Bash  — head and tail (errors and summaries sit at the end) with a note
//           between, stdout and stderr sharing one budget. Never an image
//           (stdout is then a data URI the SDK parses whole) or output that
//           carries structured content (the SDK ignores stdout then).
//   Grep  — content mode keeps whole leading lines and counts the rest.
//   Read  — deliberately NOT trimmed. The SDK records the ORIGINAL read as a
//           full view of the file, and its read-dedup answers a repeated
//           plain Read with "unchanged — refer to your earlier result": the
//           trimmed head, so the rest would be unreachable that way. The SDK's
//           own Read cap (which marks a partial view properly) still applies.

export const BASH_CAP_CHARS = 12_000;
export const GREP_CAP_CHARS = 12_000;
const BASH_TAIL_CHARS = 4_000;
// stderr's share when stdout is also long — the two render together.
const BASH_STDERR_CAP_CHARS = 6_000;

/** The longest prefix of `text` made of whole lines and at most `cap` chars. */
function headLines(text, cap) {
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf('\n', cap);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, cap);
}

function trimHeadTail(text, cap) {
  if (typeof text !== 'string' || text.length <= cap) return null;
  const head = text.slice(0, cap - BASH_TAIL_CHARS);
  const tail = text.slice(-BASH_TAIL_CHARS);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n… [${omitted} chars omitted by LLM-IDE to save context — rerun with head/tail/grep/sed -n for the part you need] …\n${tail}`;
}

/**
 * The trimmed output for `toolName`, or null when nothing needed trimming
 * (or the shape is not one this knows — then the original goes through).
 */
export function capToolOutput(toolName, response) {
  if (!response || typeof response !== 'object') return null;
  if (toolName === 'Bash') {
    if (response.isImage || (Array.isArray(response.structuredContent) && response.structuredContent.length)) return null;
    const stdout = trimHeadTail(response.stdout, BASH_CAP_CHARS);
    const stderr = trimHeadTail(response.stderr, stdout !== null ? BASH_STDERR_CAP_CHARS : BASH_CAP_CHARS);
    if (stdout === null && stderr === null) return null;
    return { ...response, ...(stdout !== null ? { stdout } : {}), ...(stderr !== null ? { stderr } : {}) };
  }
  if (toolName === 'Grep') {
    if (typeof response.content !== 'string' || response.content.length <= GREP_CAP_CHARS) return null;
    const kept = headLines(response.content, GREP_CAP_CHARS);
    const dropped = response.content.split('\n').length - kept.split('\n').length;
    return {
      ...response,
      content: `${kept}\n… [${dropped} more lines omitted by LLM-IDE to save context — narrow the pattern or the path] …`,
      numLines: kept.split('\n').length,
    };
  }
  return null;
}

/** PostToolUse hook callback (SDK HookCallback shape). */
export async function toolOutputCapHook(input) {
  const updated = capToolOutput(input?.tool_name, input?.tool_response);
  return updated ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } } : {};
}

/** The hook matcher entry for `options.hooks.PostToolUse`. */
export const TOOL_OUTPUT_CAP_HOOK = Object.freeze({ matcher: 'Bash|Grep', hooks: [toolOutputCapHook] });

/**
 * `hooks` with the cap appended to PostToolUse, plugin hooks kept as they were.
 * Not installed when native SDK plugins are loaded (`nativePlugins` > 0): all
 * PostToolUse hooks run on the ORIGINAL output and the last write wins, so a
 * trim built from the unredacted original could undo a plugin's redaction.
 */
export function withToolOutputCap(hooks = {}, { nativePlugins = 0 } = {}) {
  if (nativePlugins > 0) return hooks;
  return { ...hooks, PostToolUse: [...(hooks.PostToolUse || []), TOOL_OUTPUT_CAP_HOOK] };
}
