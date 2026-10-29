#!/usr/bin/env node
// Stub MCP server for the token bench's `mcp-two-servers` scenario (v3).
//
// A minimal stdio MCP server (newline-delimited JSON-RPC 2.0, no dependencies,
// no network, no files): `initialize`, `tools/list` and `tools/call`. It exposes
// two tools named after the server (argv[2]) so two instances add realistic
// tool-schema weight to the prompt without touching anything real.
//
//   node fake-mcp-server.mjs <server-name>

import readline from 'node:readline';

const name = (process.argv[2] || 'benchmcp').replace(/[^a-zA-Z0-9_-]/g, '');
const PROTOCOL_VERSION = '2024-11-05';

export function toolsFor(serverName) {
  return [
    {
      name: `${serverName}_lookup`,
      description: `Look up a record by key in the ${serverName} reference table. Returns a short fixed string.`,
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The record key to look up.' } },
        required: ['key'],
      },
    },
    {
      name: `${serverName}_status`,
      description: `Report the status of the ${serverName} service. Always returns "ok".`,
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

/** Answers one JSON-RPC message; returns the response object, or null for a notification. */
export function handleMessage(msg, serverName = name) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
      });
    case 'tools/list':
      return reply({ tools: toolsFor(serverName) });
    case 'tools/call': {
      const tool = msg.params?.name || '';
      const text = tool.endsWith('_status') ? 'ok' : `${serverName}: no record for "${msg.params?.arguments?.key ?? ''}"`;
      return reply({ content: [{ type: 'text', text }] });
    }
    case 'ping':
      return reply({});
    default:
      if (msg.id === undefined) return null; // notifications/initialized and friends
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const out = handleMessage(msg);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
  rl.on('close', () => process.exit(0));
}
