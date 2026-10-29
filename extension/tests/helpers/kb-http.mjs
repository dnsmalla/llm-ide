// In-process HTTP harness for route tests: the real KB router (handleKB) behind a
// plain node http server on 127.0.0.1, with the authenticated user supplied by
// the test instead of a JWT. Errors are answered as the server answers them
// (core/errors sendError). No model, no network beyond loopback.
import http from 'node:http';
import { handleKB } from '../../routes/router.mjs';
import { sendError } from '../../core/errors.mjs';

export async function startKbServer() {
  const state = { userId: null };
  const server = http.createServer(async (req, res) => {
    req.user = { id: state.userId };
    try {
      const handled = await handleKB(req, res);
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }));
      }
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    as(userId) { state.userId = userId; return this; },
    // node:http, not fetch: fetch normalises or rejects malformed escapes, and the
    // point of some tests is to send exactly the bytes they name.
    call(method, reqPath, body) {
      const payload = body === undefined ? undefined
        : (typeof body === 'string' ? body : JSON.stringify(body));
      return new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, method, path: reqPath, agent: false,
          headers: payload === undefined ? {} : {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
          },
        }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { text += c; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            resolve({ status: res.statusCode, body: json, text });
          });
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      });
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}
