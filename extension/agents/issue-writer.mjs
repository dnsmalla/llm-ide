// Compatibility re-export. The writer lives in server/ so routes, agents and llm_agent tools can share it without an
// agents -> llm_agent (or llm_agent -> agents) layer edge.
export * from '../server/issue-writer.mjs';
