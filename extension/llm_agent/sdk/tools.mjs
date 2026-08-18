// The llmide in-process MCP server — LLM-IDE domain tools for the Agent SDK
// engine. Extracted from the P0 spike so the v2 engine mounts the same KB
// tool without importing the spike module.
//
// buildLlmIdeServer(userId) returns the McpSdkServerConfigWithInstance the
// SDK query() `mcpServers` option consumes: tools run in the engine's own
// process (no subprocess, no wire), and each handler closes over the calling
// user so every KB read stays tenant-scoped.
//
// Every field of every hit passes redactFence before it reaches the model —
// tool text must never carry a live fence sentinel (the shared prompt-
// injection defense, ../runtime/redaction.mjs).

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as kb from '../../kb/db.mjs';
import { redactFence } from '../runtime/redaction.mjs';

// --- Domain tool: KB search as an in-process SDK MCP tool -----------------

export function buildLlmIdeServer(userId) {
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

  return createSdkMcpServer({
    name: 'llmide',
    version: '0.1.0',
    instructions: 'LLM-IDE domain tools. kb_search queries the local knowledge base.',
    tools: [kbSearch],
  });
}
