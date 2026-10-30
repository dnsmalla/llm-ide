// Read handler: this workspace's accumulated project memory (Graphify),
// exposed as a callable tool (not always-on injection — see
// graphkit/memory-writer.mjs and sdk/engine.mjs's header comment for why).
// Moved out of sdk/tools.mjs (P1 spike) so both engines share ONE
// implementation via the tools registry.
import { renderGraphifyMemory } from '../../../graphkit/index.mjs';
import { redactFence } from '../redaction.mjs';

// The tool's result is not a one-turn cost: it stays in the chat transcript
// and is re-read (as cache) on every later turn. The always-on budget
// (config.memory.totalChars, 40k) made one call worth ~10k tokens for the rest
// of the chat; a quarter of it keeps the priority content.
export const PROJECT_MEMORY_TOOL_CHARS = 10_000;

export function handleProjectMemory(args, ctx) {
  const stats = [];
  const focus = typeof args?.focus === 'string' && args.focus ? args.focus : (ctx.currentMessage || '');
  const renderMemory = ctx.renderMemory || renderGraphifyMemory;
  const block = renderMemory(ctx.agentContext, ctx.userId, stats, focus, { totalChars: PROJECT_MEMORY_TOOL_CHARS });
  const text = block ? redactFence(block) : 'No project memory has been generated for this workspace yet.';
  return { text };
}
