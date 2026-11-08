// Hub mode refuses a stdio MCP server (REQ-014 B6/F16): on a shared hub the server would run as the core's OS user.
// Remote (HTTP/SSE) transports are unchanged. The refusal is a coded error, not a silent skip, on the connect path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const { transportFor } = await import('../providers/adapter/mcp-client.mjs');

test('a hub refuses to start a stdio MCP server with MCP_STDIO_DISABLED_IN_HUB', () => {
  assert.throws(
    () => transportFor({ command: process.execPath, args: ['-e', ''] }, { hub: true }),
    (e) => e.code === 'MCP_STDIO_DISABLED_IN_HUB',
  );
});

test('a hub still builds an HTTP transport, and a normal core still builds a stdio one', async () => {
  const http = transportFor({ type: 'http', url: 'https://mcp.example.com/mcp' }, { hub: true });
  assert.ok(http, 'remote transports are unchanged');
  await http.close?.().catch(() => {});
  const stdio = transportFor({ command: process.execPath, args: ['-e', ''] }, { hub: false });
  assert.ok(stdio, 'a solo install keeps its stdio servers');
  await stdio.close?.().catch(() => {});
});
