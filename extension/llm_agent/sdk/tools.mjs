// The llmide in-process MCP server — mounts every registry entry
// (llm_agent/tools/registry.mjs) as an SDK tool. This file is the ONLY
// module that converts the registry's plain-JSON schema (shared with the
// legacy .md frontmatter) into zod — see zodSchemaFor. Per-entry logic lives
// in runtime/handlers/*.mjs via the registry; this file adds no domain logic.
//
// buildLlmIdeServer(userId, agentContext, currentMessage, { renderMemory, ... })
// returns the McpSdkServerConfigWithInstance the SDK query() `mcpServers`
// option consumes: tools run in the engine's own process (no subprocess, no
// wire), and each handler closes over the calling user so every read stays
// tenant-scoped. `readableRoots`/`kb` are built here (matching how route.mjs
// builds the same two values for the legacy engine) and threaded into every
// mounted tool's shared ctx.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as kb from '../../kb/db.mjs';
import { entries } from '../tools/registry.mjs';
import { globalSkills } from '../skills/index.mjs';
import { buildReadableRoots } from '../runtime/handlers/repo-files.mjs';
import { resolveChatSessionId } from '../../kb/session-memory.mjs';

// The .md frontmatter param types this compiler understands. An unrecognized
// type used to fall through to `z.string()` silently — a skill declaring e.g.
// `type: boolean` would mount with a wrong-but-plausible schema and only fail
// at call time, deep inside a handler. Fail loudly at mount instead.
function zodFor(paramDef, key) {
  let z_;
  switch (paramDef.type) {
    case 'string': z_ = z.string(); break;
    case 'number': z_ = z.number(); break;
    case 'boolean': z_ = z.boolean(); break;
    case 'string[]': z_ = z.array(z.string()); break;
    default:
      throw new Error(`unsupported schema type "${paramDef.type}" for param "${key}" — llm_agent/sdk/tools.mjs must learn it before a skill can declare it`);
  }
  if (Array.isArray(paramDef.enum)) {
    z_ = z.enum(paramDef.enum);
  } else if (paramDef.type === 'string' || paramDef.type === 'string[]') {
    // Length caps declared in the .md frontmatter (e.g. run-bash's 2000-char
    // command cap) were dropped entirely before — documented but unenforced on
    // v2, so a mounted tool accepted input the legacy validator rejected.
    // `.min`/`.max` mean LENGTH for strings and arrays (never for numbers,
    // where they'd mean value bounds — hence the type guard); an enum carries
    // its own domain, so it's left alone.
    if (Number.isFinite(paramDef.maxLength)) z_ = z_.max(paramDef.maxLength);
    if (Number.isFinite(paramDef.minLength)) z_ = z_.min(paramDef.minLength);
  }
  if (paramDef.description) z_ = z_.describe(paramDef.description);
  if (!paramDef.required) z_ = z_.optional();
  if (paramDef.default !== undefined) z_ = z_.default(paramDef.default);
  return z_;
}

function zodSchemaFor(schema) {
  const shape = {};
  for (const [key, def] of Object.entries(schema || {})) shape[key] = zodFor(def, key);
  return shape;
}

// Test-only seam: the compiler is module-private (no domain logic belongs to
// callers), but its throw-on-unknown-type contract needs direct coverage that
// doesn't depend on shipping a deliberately-broken skill file.
export const __zodSchemaForTest = zodSchemaFor;

function metaFor(entry) {
  const skill = globalSkills.skills.get(entry.name);
  if (skill) return { description: skill.description || entry.name, schema: skill.schema || {} };
  return entry.inlineMeta || { description: entry.name, schema: {} };
}

export function buildLlmIdeServer(userId, agentContext, currentMessage, {
  renderMemory, runClaude, userSkills, userSubagents, internalSkills,
} = {}) {
  const readableRoots = buildReadableRoots({ userId, workspaceRoot: agentContext?.workspaceRoot });
  const toolCtx = {
    userId, agentContext, currentMessage, renderMemory, kb, readableRoots,
    runClaude, userSkills, userSubagents, internalSkills,
    // Same resolver the legacy loop uses (kb/session-memory.mjs) — a chat's
    // task-create/task-update/task-list calls must key onto the SAME
    // session id across both engines, not a raw agentContext.sessionId.
    sessionId: resolveChatSessionId(agentContext),
  };
  // ALL registry entries mount now, read AND act — canUseTool (sdk/
  // engine.mjs) is what actually restricts act tools (always-allow → gate
  // → allow/deny/prompt), not this mount list.
  const sdkTools = entries().map((entry) => {
    const meta = metaFor(entry);
    return tool(
      entry.name,
      meta.description,
      zodSchemaFor(meta.schema),
      async (args) => {
        const result = await Promise.resolve(entry.execute(args, toolCtx));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
      // readOnlyHint must tell the TRUTH per entry: MCP hosts use it to decide
      // whether a call needs approval at all, so hardcoding `true` for
      // run-bash/task-create/task-update actively undercut the gate whose
      // whole job is to require approval for exactly those.
      { annotations: { readOnlyHint: entry.kind === 'read' }, alwaysLoad: true },
    );
  });

  return createSdkMcpServer({
    name: 'llmide',
    version: '0.2.0',
    instructions: 'LLM-IDE domain tools — see each tool\'s description.',
    tools: sdkTools,
  });
}
