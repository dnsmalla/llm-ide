// Built-in chat slash commands — recognized as real UI actions the same way
// Claude Code's own /clear works, NOT sent to the model as a prompt. This is
// deliberately separate from llm-ide's own plugin slash-command system
// (extension/plugins/loader.mjs's expandSlashCommand, wired in
// llm_agent/runtime/route.mjs): that system expands a command into a PROMPT
// for the LLM to see; these intercept the message before it ever reaches
// sendMessage, the same way Claude Code's REPL never forwards /clear to the
// model. Aliases match commands.json's documented aliases for /clear.
const CLEAR_COMMANDS = new Set(['/clear', '/reset', '/new']);

/** Whether `text` (as typed, before any send) is a built-in "clear chat" command. */
export function isBuiltinClearCommand(text: string): boolean {
  return CLEAR_COMMANDS.has(text.trim().toLowerCase());
}
