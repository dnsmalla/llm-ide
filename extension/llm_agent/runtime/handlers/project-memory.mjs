// Read handler: this workspace's accumulated project memory (Graphify),
// exposed as a callable tool (not always-on injection — see
// graphkit/memory-writer.mjs and sdk/engine.mjs's header comment for why).
// Moved out of sdk/tools.mjs (P1 spike) so both engines share ONE
// implementation via the tools registry.
import { renderGraphifyMemory } from '../../../graphkit/index.mjs';
import { redactFence } from '../redaction.mjs';

export function handleProjectMemory(args, ctx) {
  const stats = [];
  const focus = typeof args?.focus === 'string' && args.focus ? args.focus : (ctx.currentMessage || '');
  const renderMemory = ctx.renderMemory || renderGraphifyMemory;
  const block = renderMemory(ctx.agentContext, ctx.userId, stats, focus);
  const text = block ? redactFence(block) : 'No project memory has been generated for this workspace yet.';
  return { text };
}
