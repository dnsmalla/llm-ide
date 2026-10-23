// Pure constants of the Claude linker (llm_agent/sdk/) that callers OUTSIDE
// the engine need. They live here — a module with no imports — so a route can
// name them without importing engine.mjs, which drags in the Agent SDK and
// the whole engine graph (~200 ms of module loading). engine.mjs re-exports
// them, so existing importers keep working and there is still one definition.

// The provider id every SDK-engine turn runs on — the usage ledger and the
// route layer meter against this instead of hardcoding the string, so "which
// provider the Agent SDK is" stays linker knowledge.
export const AGENT_SDK_PROVIDER = 'anthropic';

// The in-process MCP server name the engine registers for its own tools; a
// user-configured MCP server with this name is refused (engine.mjs
// buildUserMcpServers) and must not be reported as effective (auth-routes).
export const RESERVED_MCP_NAME = 'llmide';

// The cap on one composed Loop message (goal + failure output + instructions).
// The message is small in practice; this only bounds a pathological one. Here
// rather than in loop-agent.mjs because routes/loop-agent.mjs validates against
// it BEFORE importing the Loop engine — a malformed request must not cost the
// Agent SDK import. loop-agent.mjs re-exports it.
export const MAX_LOOP_MESSAGE_CHARS = 200_000;
