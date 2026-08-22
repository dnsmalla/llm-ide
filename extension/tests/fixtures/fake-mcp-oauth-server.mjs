// Hermetic remote-MCP fixture. One node:http server on 127.0.0.1:0 playing
// both roles a real remote MCP server plays:
//
//   * OAuth 2.1 authorization server — RFC 9728 protected-resource metadata,
//     RFC 8414 authorization-server metadata, RFC 7591 dynamic client
//     registration, an /authorize endpoint standing in for the browser
//     consent screen, and a /token endpoint that genuinely VERIFIES the
//     PKCE S256 challenge (so a code_verifier lost in the vault fails here,
//     loudly, instead of passing).
//
//   * MCP resource server — 401 + WWW-Authenticate until a Bearer token this
//     fixture minted arrives, then a real Streamable-HTTP MCP endpoint.
//
// The MCP half is the SDK's OWN server (McpServer + StreamableHTTPServerTransport)
// so protocol correctness is not something a fixture has to re-derive. Only
// the OAuth half is hand-written, because the OAuth half is what we test.
//
// A fresh McpServer + transport is built PER REQUEST (stateless mode). This is
// not a style choice: reusing one instance across connections makes the second
// client's notifications/initialized POST return 500.
//
// No test may reach the real mcp.miro.com. Everything here binds an ephemeral
// loopback port and speaks only to itself.

import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// The default pair keeps every phase-2a test working unchanged: same names,
// same static payloads. Phase 2b tests pass their own `tools` array.
const DEFAULT_TOOLS = [
  { name: 'list_boards', description: 'List Miro boards', result: [{ id: 'b1', name: 'Board One' }] },
  { name: 'get_board_items', description: 'Read one board', result: [{ type: 'sticky_note', text: 'hello' }] },
];

// z.looseObject({}) rather than the raw shape `{}`. Verified: an empty raw
// shape normalises to a STRICT z.object({}), which strips unknown keys, so a
// handler called with { board_id: 'b2' } receives {} and every argument
// assertion in a fetch test would be vacuously true. looseObject passes the
// arguments through untouched — which is what a real server does.
const LOOSE = z.looseObject({});

const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

/**
 * Start the fixture. Always `await handle.close()` (use `t.after`).
 * @param {{ issuerPath?: string, tools?: Array<{name,description?,result?,handler?,textOnly?,structured?,error?}> }} [opts]
 */
export async function startFakeMcpServer(opts = {}) {
  const tools = opts.tools || DEFAULT_TOOLS;
  let issuerPath = opts.issuerPath || '/';

  const codes = new Map();          // authorization code -> { challenge }
  const accessTokens = new Set();   // tokens this fixture minted
  const requests = [];
  const registrations = [];
  const tokenRequests = [];
  const toolCalls = [];             // { name, args } per tools/call, in order

  function buildMcpServer() {
    const mcp = new McpServer({ name: 'fake-miro', version: '0.0.1' });
    for (const spec of tools) {
      mcp.registerTool(
        spec.name,
        { description: spec.description || spec.name, inputSchema: LOOSE },
        async (args) => {
          toolCalls.push({ name: spec.name, args: args ?? {} });

          // A tool that fails on the server. The SDK turns a throw into
          // { isError: true, content: [...] } — a RESULT, not a rejection —
          // so this is the only faithful way to exercise that path.
          if (spec.error) throw new Error(spec.error);

          const value = spec.handler ? await spec.handler(args ?? {}) : spec.result;

          // textOnly: prose, not JSON. Real servers do this and a parser that
          // assumes JSON.parse succeeds will throw on the first such tool.
          if (spec.textOnly) {
            return { content: [{ type: 'text', text: String(value) }] };
          }
          const out = { content: [{ type: 'text', text: JSON.stringify(value) }] };
          if (spec.structured) out.structuredContent = value;
          return out;
        },
      );
    }
    return mcp;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const origin = `http://${req.headers.host}`;
    const issuer = origin + issuerPath;
    requests.push(`${req.method} ${u.pathname}`);

    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const readBody = () => new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => resolve(b));
    });

    // RFC 9728 — which authorization server guards this resource? The SDK
    // probes both the path-aware and root forms, so match on the prefix.
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ['boards:read'],
      });
    }

    // RFC 8414 — authorization server metadata.
    if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(200, {
        issuer,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['boards:read'],
      });
    }

    // RFC 7591 — dynamic client registration (Miro's model: no BYO client).
    if (u.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse((await readBody()) || '{}');
      registrations.push(meta);
      return json(201, {
        ...meta,
        client_id: `dcr-${crypto.randomUUID()}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
    }

    // The consent screen. Tests call handle.authorize() instead of a browser.
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      const code = `code-${crypto.randomBytes(8).toString('hex')}`;
      codes.set(code, { challenge: q.get('code_challenge') });
      const loc = new URL(q.get('redirect_uri'));
      loc.searchParams.set('code', code);
      if (q.get('state')) loc.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: loc.toString() });
      res.end();
      return;
    }

    // Token endpoint. PKCE is verified for real.
    if (u.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await readBody());
      tokenRequests.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'authorization_code') {
        const rec = codes.get(p.get('code'));
        if (!rec) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
        if (s256(p.get('code_verifier') || '') !== rec.challenge) {
          return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
        codes.delete(p.get('code'));       // single use
      } else if (p.get('grant_type') !== 'refresh_token') {
        return json(400, { error: 'unsupported_grant_type' });
      }
      const at = `at-${crypto.randomBytes(12).toString('hex')}`;
      accessTokens.add(at);
      return json(200, {
        access_token: at, token_type: 'Bearer', expires_in: 3600,
        refresh_token: 'rt-fixture', scope: 'boards:read',
      });
    }

    // The MCP endpoint, gated on a token this fixture minted. The 401 must
    // carry WWW-Authenticate with resource_metadata — that header is what
    // drives the SDK's re-auth path.
    if (u.pathname === '/mcp') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || !accessTokens.has(auth.slice(7))) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const mcp = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,   // stateless
        enableJsonResponse: true,
      });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      return transport.handleRequest(req, res);
    }

    return json(404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    url: `${origin}/mcp`,
    get issuer() { return origin + issuerPath; },
    requests,
    registrations,
    tokenRequests,
    toolCalls,

    /** Stand in for the user's browser: follow the authorization URL once. */
    async authorize(authorizationUrl) {
      const r = await fetch(String(authorizationUrl), { redirect: 'manual' });
      const location = r.headers.get('location');
      if (!location) throw new Error(`fixture /authorize did not redirect (status ${r.status})`);
      const loc = new URL(location);
      return {
        code: loc.searchParams.get('code'),
        state: loc.searchParams.get('state'),
        redirectUri: `${loc.origin}${loc.pathname}`,
      };
    },

    /** Invalidate every minted access token — the "session expired" case. */
    revokeAccessTokens() { accessTokens.clear(); },

    /** Move the authorization server; proves credentials are issuer-scoped. */
    setIssuerPath(p) { issuerPath = p; },

    clearLog() { requests.length = 0; toolCalls.length = 0; },

    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
