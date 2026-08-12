// Minimal stdio MCP server: answers initialize + tools/list + tools/call for one
// tool `echo`. Run as `node fake-mcp-server.mjs`.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.1' } } });
  } else if (msg.method === 'notifications/initialized') {
    /* no response */
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? '';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } });
  }
});
