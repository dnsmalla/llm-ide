// Per-turn tool accounting from the v2 event stream the route already
// forwards: `tool_use_start` names a call, `tool_result` carries its (capped)
// output. One observer covers native SDK tools (Read, Grep, Bash…) and the
// llmide MCP tools alike. Names and sizes only — never the text.

const LLMIDE_PREFIX = 'mcp__llmide__';

export function normalizeToolName(name) {
  const n = typeof name === 'string' ? name : '';
  return n.startsWith(LLMIDE_PREFIX) ? n.slice(LLMIDE_PREFIX.length) : n;
}

export function createToolAccounting() {
  const nameById = new Map();
  const out = [];
  return {
    observe(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'tool_use_start' && typeof ev.id === 'string') {
        nameById.set(ev.id, normalizeToolName(ev.name));
        return;
      }
      if (ev.type === 'tool_result') {
        out.push({
          tool: nameById.get(ev.toolUseId) || 'unknown',
          // events.mjs caps text at 20k chars and sets `truncated` — so a
          // truncated result means "at least" this many.
          resultChars: typeof ev.text === 'string' ? ev.text.length : 0,
          truncated: ev.truncated === true,
          isError: ev.isError === true,
        });
      }
    },
    events() { return out.slice(); },
  };
}
