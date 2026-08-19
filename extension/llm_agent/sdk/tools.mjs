// The llmide in-process MCP server — LLM-IDE domain tools for the Agent SDK
// engine. Extracted from the P0 spike so the v2 engine mounts the same KB
// tool without importing the spike module.
//
// buildLlmIdeServer(userId, agentContext, currentMessage, { renderMemory })
// returns the McpSdkServerConfigWithInstance the SDK query() `mcpServers`
// option consumes: tools run in the engine's own process (no subprocess, no
// wire), and each handler closes over the calling user so every KB read
// stays tenant-scoped. `agentContext`/`currentMessage` are only needed by
// project_memory (below) — both optional, kb_search ignores them.
// `renderMemory` is the injectable seam for project_memory's Graphify call
// (defaults to the real renderGraphifyMemory; overridable so tests can
// verify the tool's wiring without a real indexed repo on disk).
//
// Every field of every hit passes redactFence before it reaches the model —
// tool text must never carry a live fence sentinel (the shared prompt-
// injection defense, ../runtime/redaction.mjs).

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as kb from '../../kb/db.mjs';
import { redactFence } from '../runtime/redaction.mjs';
import { renderGraphifyMemory } from '../../graphkit/index.mjs';

// --- Domain tool: KB search as an in-process SDK MCP tool -----------------

export function buildLlmIdeServer(userId, agentContext, currentMessage, { renderMemory = renderGraphifyMemory } = {}) {
  const kbSearch = tool(
    'kb_search',
    'Full-text search across the user\'s LLM-IDE knowledge base (meetings, decisions, action items, ingested sources). Use this whenever a question might be answered by past meetings or project notes.',
    {
      query: z.string().describe('Free-text search query'),
      limit: z.number().int().max(50).default(10).describe('Max hits to return'),
    },
    async (args) => {
      const raw = await Promise.resolve(kb.search(userId, { q: args.query, kind: null, limit: args.limit }));
      const list = Array.isArray(raw) ? raw : [];
      const hits = list.map((h) => ({
        kind: redactFence(h.kind),
        id: h.id != null ? redactFence(String(h.id)) : '',
        title: redactFence(h.title || ''),
        snippet: redactFence(h.snippet || ''),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ hits, total: list.length }) }] };
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );

  // Project memory (Graphify) as a TOOL rather than always-on injection —
  // unlike the legacy loop (llm_agent/runtime/route.mjs), which inlines
  // renderGraphifyMemory into every prompt unconditionally, v2 is tool-driven
  // by design (same reasoning as kb_search): the model reaches for it when
  // grounded project context would help, instead of paying its token cost on
  // every turn whether or not it's relevant. renderGraphifyMemory is
  // self-gated (per-user repo allow-list, its own char caps) and redactFence
  // covers the same untrusted-content risk as kb_search's hits — the memory
  // is derived from indexed-repo files, which can include third-party text.
  const projectMemory = tool(
    'project_memory',
    'Retrieve this project\'s accumulated memory — durable, auto-generated facts, decisions, and Q&A distilled from past sessions in this repo/workspace. Call this when grounded project-specific context (past decisions, known issues, prior answers) would improve the answer, instead of guessing. Returns a short note if no project memory has been generated yet.',
    {
      focus: z.string().optional().describe('Optional topic to prioritize when selecting which memory to include; defaults to the current user message'),
    },
    async (args) => {
      const stats = [];
      const focus = typeof args.focus === 'string' && args.focus ? args.focus : (currentMessage || '');
      const block = renderMemory(agentContext, userId, stats, focus);
      const text = block ? redactFence(block) : 'No project memory has been generated for this workspace yet.';
      return { content: [{ type: 'text', text }] };
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );

  return createSdkMcpServer({
    name: 'llmide',
    version: '0.1.0',
    instructions: 'LLM-IDE domain tools. kb_search queries the local knowledge base; project_memory retrieves this project\'s accumulated durable memory.',
    tools: [kbSearch, projectMemory],
  });
}
