// Read handler: `ask-internal` delegated a question to a nested internal agent loop (the classic
// fence loop). That loop is gone (agent-kit K1 P6 T6.8): the v2 engine never mounts this tool (it has
// native search-kb / project_memory / Read) and the provider adapter refuses it. The name stays
// registered so the skill set (central kit) keeps one handler per core read skill, and a stray call
// gets an honest answer instead of "no handler".
import { searchKb } from './search-kb.mjs';

export const INTERNAL_HANDLERS = { 'search-kb': searchKb };

export async function askInternal() {
  return {
    error: 'ask-internal is not available any more: use search-kb or project_memory directly.',
    pendingTool: null,
  };
}
