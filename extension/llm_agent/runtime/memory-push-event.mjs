// The legacy engine pushes repo memory into every turn's system prompt; this
// records its size as a turn_tool_events row so the report can weigh it
// against v2's pull-based find-code/project_memory.
export function memoryPushEvent(memoryChars) {
  const n = Math.trunc(Number(memoryChars) || 0);
  return n > 0 ? [{ tool: 'memory_push', resultChars: n }] : [];
}
