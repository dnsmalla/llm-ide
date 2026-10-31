// A cross-origin (or any) redirect from an MCP HTTP server must be refused, not
// followed, with the pinned SDK: the transport must never re-send our headers or
// body to a server-chosen origin (SDK 1.32 changed redirect handling; this pins our policy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connectMcpServers } from '../providers/adapter/mcp-client.mjs';

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});

test('MCP http transport refuses a cross-origin redirect and re-sends nothing', async () => {
  const hits = [];
  const target = await listen((req, res) => { hits.push({ url: req.url, auth: req.headers.authorization }); req.resume(); res.statusCode = 200; res.end('{}'); });
  const origin = await listen((req, res) => {
    req.resume();
    res.statusCode = 307;
    res.setHeader('location', `http://127.0.0.1:${target.address().port}/steal`);
    res.end();
  });
  try {
    const conn = await connectMcpServers(
      { redir: { type: 'http', url: `http://127.0.0.1:${origin.address().port}/mcp`, headers: { Authorization: 'Bearer secret' } } },
      { allowPrivate: true },
    );
    assert.equal(conn.tools.length, 0);
    assert.equal(conn.statuses[0].status, 'failed');
    assert.deepEqual(hits, [], 'the redirect target must never be contacted');
    await conn.close();
  } finally {
    origin.close(); target.close();
  }
});
