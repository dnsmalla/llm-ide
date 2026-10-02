// Trims oversized NATIVE tool output (Read / Bash / Grep) before the model
// sees it — a PostToolUse hook's `updatedToolOutput`.
//
// Why: every hop of an agent turn re-reads the whole context, so a single
// 60k-char file read is paid for again on every later hop of the turn and
// every later turn of the chat (measured on real turns: 147k–895k cached
// tokens re-read per work turn). The SDK's own Read cap is ~25k TOKENS; these
// caps are a few thousand, and each trim tells the model how to get the rest.
//
// Shape-preserving: the result is the same output object with only its text
// fields shortened, so the SDK formats it exactly as before.
//   Read  — keeps the HEAD only, on a line boundary, and sets
//           truncatedByTokenCap: the SDK then tells the model to continue with
//           offset/limit. Never the middle: the SDK numbers lines from
//           startLine, so a removed middle would misnumber everything after it.
//   Bash  — keeps head and tail (errors and summaries sit at the end) with a
//           note between them.
//   Grep  — content mode keeps whole leading lines and counts the rest.

export const READ_CAP_CHARS = 20_000;
export const BASH_CAP_CHARS = 12_000;
export const GREP_CAP_CHARS = 12_000;
const BASH_TAIL_CHARS = 4_000;

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
  if (toolName === 'Read') {
    const file = response.file;
    if (response.type !== 'text' || !file || typeof file.content !== 'string' || file.content.length <= READ_CAP_CHARS) return null;
    const content = headLines(file.content, READ_CAP_CHARS);
    return { ...response, file: { ...file, content, numLines: content.split('\n').length, truncatedByTokenCap: true } };
  }
  if (toolName === 'Bash') {
    const stdout = trimHeadTail(response.stdout, BASH_CAP_CHARS);
    const stderr = trimHeadTail(response.stderr, BASH_CAP_CHARS);
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
export const TOOL_OUTPUT_CAP_HOOK = Object.freeze({ matcher: 'Read|Bash|Grep', hooks: [toolOutputCapHook] });

/** `hooks` with the cap appended to PostToolUse, plugin hooks kept as they were. */
export function withToolOutputCap(hooks = {}) {
  return { ...hooks, PostToolUse: [...(hooks.PostToolUse || []), TOOL_OUTPUT_CAP_HOOK] };
}
