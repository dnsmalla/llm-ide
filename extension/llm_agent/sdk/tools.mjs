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

function zodFor(paramDef) {
  let z_;
  switch (paramDef.type) {
    case 'number': z_ = z.number(); break;
    default: z_ = z.string();
  }
  if (Array.isArray(paramDef.enum)) z_ = z.enum(paramDef.enum);
  if (paramDef.description) z_ = z_.describe(paramDef.description);
  if (!paramDef.required) z_ = z_.optional();
  if (paramDef.default !== undefined) z_ = z_.default(paramDef.default);
  return z_;
}

function zodSchemaFor(schema) {
  const shape = {};
  for (const [key, def] of Object.entries(schema || {})) shape[key] = zodFor(def);
  return shape;
}

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
  };
  const sdkTools = entries().filter((e) => e.kind === 'read').map((entry) => {
    const meta = metaFor(entry);
    return tool(
      entry.name,
      meta.description,
      zodSchemaFor(meta.schema),
      async (args) => {
        const result = await Promise.resolve(entry.execute(args, toolCtx));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
      { annotations: { readOnlyHint: true }, alwaysLoad: true },
    );
  });

  return createSdkMcpServer({
    name: 'llmide',
    version: '0.2.0',
    instructions: 'LLM-IDE domain tools — see each tool\'s description.',
    tools: sdkTools,
  });
}
