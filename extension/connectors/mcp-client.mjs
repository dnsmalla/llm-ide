// MCP client for ingestion connectors — one generic adapter for every remote
// MCP server we fetch content from (Miro today; Google Drive and Calendar in
// phase 3). Nothing here branches on a connector: it reads a descriptor from
// connectors/mcp-connector-defs.mjs and does the same thing for all of them.
//
// Three responsibilities live in this file because they are one flow, the way
// connectors/slack-oauth.mjs keeps its helper and its state map together:
//
//   1. VaultOAuthProvider — the SDK's OAuthClientProvider backed by the
//      per-user encrypted vault.
//   2. The OAuth-flow state map — an in-memory, TTL-swept, single-use store
//      linking the `state` parameter back to (userId, connectorId).
//   3. Session helpers — connect, run, close. Never pooled: ingestion runs on
//      a timer and a long-lived session buys nothing but lifecycle bugs.
//
// ── Import specifiers ───────────────────────────────────────────────────────
// The package's exports map publishes "./client" (Client only) plus a "./*"
// wildcard onto dist/esm. The transport and UnauthorizedError are reachable
// only through the wildcard, which is also what the existing tests use. Never
// write a dist/esm path — that bypasses the exports map.
//
// ── Vault key scheme ────────────────────────────────────────────────────────
// The SDK is explicit that a client registered with one authorization server
// must never be presented to another, so credentials are keyed by connector id
// AND issuer. The catch: the transport calls tokens() to build the Authorization
// header BEFORE any discovery, so the namespace must be computable offline.
//
//   mcp.<id>.issuer                    last discovered authorization server
//   mcp.<id>-<tag>.clientInformation   DCR result, or the operator's BYO client
//   mcp.<id>-<tag>.tokens              access + refresh token
//   mcp.<id>-<tag>.codeVerifier        PKCE verifier, in flight only
//
// <tag> = sha256(boundIssuer)[0..12). boundIssuer starts from the recorded
// issuer and falls back to the MCP server's own origin on a cold start;
// saveDiscoveryState() rebinds it, and the SDK always calls that before
// clientInformation(). When the issuer changes the tag changes, the old
// credentials become unreachable (orphaned, not deleted), and the SDK
// re-registers. Cross-issuer reuse is impossible by construction.
//
// All four shapes satisfy server/vault.mjs's MCP_CREDENTIAL_KEY_RE — adding an
// MCP connector never requires a vault change.
//
// discoveryState() is deliberately NOT implemented: caching discovery would
// require knowing the issuer before we know the issuer. Two extra well-known
// GETs, only on the cold or expired path, is the right trade.

import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../core/config.mjs';
import { getSecret, setSecret } from '../server/vault.mjs';
import { getMcpConnectorSeenIds, markMcpConnectorSeen } from '../kb/db.mjs';
import { toItemArray, pickPath, defaultMcpItemMapper } from './mcp-connector-defs.mjs';

const CLIENT_INFO = { name: 'llm-ide', version: '1.0.0' };
const CONNECT_TIMEOUT_MS = 20_000;
const STATE_TTL_MS = 10 * 60 * 1000;
const TOOL_TIMEOUT_MS = 60_000;
// Bound one sweep. Both are deliberately modest: ingestion runs on a timer,
// so leaving work for the next tick is free, while a single unbounded sweep
// over a large workspace is a 10-minute request that times out and imports
// nothing.
const MAX_PARENTS = 25;
const DEFAULT_ITEM_LIMIT = 50;
// Per-note ceiling. MCP caps tool OUTPUT (25k tokens by default), but the
// binding constraint here is downstream: each item becomes one classify call,
// and a 100k-char board export makes that call slow, expensive and worse at
// its job. ~12k chars ≈ 3k tokens — a comfortable note.
export const MAX_ITEM_CHARS = 12_000;
// A single-level source (phase 3's gcal: `list_events` IS the content) has no
// readTool, so its listTool doubles as the item descriptor. The mapper reads
// its text selectors off `readTool.textFields`, and a list descriptor has no
// reason to carry any — without a generic fallback every such item would land
// as pickText's JSON dump. Provider-agnostic on purpose: no connector is named.
const GENERIC_TEXT_FIELDS = Object.freeze([
  'text', 'content', 'description', 'summary', 'body', 'title', 'name',
]);

/** Where every MCP connector's authorization redirect lands. */
export function mcpRedirectUri() {
  return `http://127.0.0.1:${config.port}/auth/mcp-connector/callback`;
}

function issuerTag(issuer) {
  return crypto.createHash('sha256').update(String(issuer)).digest('hex').slice(0, 12);
}

/** Tagged "connect this connector first" error, distinct from a transport fault. */
function mcpUnauthorized(def) {
  const e = new Error(`Not connected to ${def.name}. Connect it in Settings first.`);
  e.code = 'MCP_UNAUTHORIZED';
  return e;
}

// ─── OAuthClientProvider, backed by the vault ───────────────────────────────

export class VaultOAuthProvider {
  /**
   * @param {{ db: object, userId: string, def: object,
   *           stateToken?: string, onAuthorizationUrl?: (url: string) => void }} o
   */
  constructor({ db, userId, def, stateToken, onAuthorizationUrl }) {
    this.db = db;
    this.userId = userId;
    this.def = def;
    this.stateToken = stateToken;
    this.onAuthorizationUrl = onAuthorizationUrl;
    /** Captured by redirectToAuthorization — there is no user agent here. */
    this.authorizationUrl = null;
    this.issuerKey = `mcp.${def.id}.issuer`;
    this.boundIssuer = getSecret(db, userId, this.issuerKey)
      || new URL('/', def.serverUrl).toString();
  }

  /** Vault key for one credential field, in the current issuer namespace. */
  key(field) {
    return `mcp.${this.def.id}-${issuerTag(this.boundIssuer)}.${field}`;
  }

  _read(field) { return getSecret(this.db, this.userId, this.key(field)) || null; }
  _readJson(field) {
    const raw = this._read(field);
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  _write(field, value) { setSecret(this.db, this.userId, this.key(field), value); }

  // --- required hooks ---

  get redirectUrl() { return mcpRedirectUri(); }

  get clientMetadata() {
    return {
      client_name: this.def.clientName,
      redirect_uris: [mcpRedirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.def.byoClient ? 'client_secret_post' : 'none',
      scope: this.def.scope,
    };
  }

  clientInformation() {
    const stored = this._readJson('clientInformation');
    if (stored) return stored;
    if (!this.def.byoClient) return undefined;   // DCR will register one
    // Operator-provisioned client (Google, phase 3): not issuer-scoped —
    // it belongs to the descriptor, not to a discovered server.
    const id = getSecret(this.db, this.userId, this.def.byoClientIdKey);
    const secret = getSecret(this.db, this.userId, this.def.byoClientSecretKey);
    if (!id) return undefined;
    return secret ? { client_id: id, client_secret: secret } : { client_id: id };
  }

  saveClientInformation(ci) { this._write('clientInformation', JSON.stringify(ci)); }

  tokens() { return this._readJson('tokens'); }
  saveTokens(t) { this._write('tokens', JSON.stringify(t)); }

  saveCodeVerifier(v) { this._write('codeVerifier', v); }
  codeVerifier() {
    const v = this._read('codeVerifier');
    if (!v) throw new Error('No PKCE code verifier saved — start the connection again.');
    return v;
  }

  /**
   * The SDK's name for this hook is aspirational on a server: there is no
   * user agent to redirect. Capture the URL so the start route can hand it
   * to the Mac app, which opens the user's browser.
   */
  redirectToAuthorization(authorizationUrl) {
    this.authorizationUrl = authorizationUrl.toString();
    this.onAuthorizationUrl?.(this.authorizationUrl);
  }

  // --- optional hooks we do implement ---

  /** Our own state token, so /auth/mcp-connector/callback can find the user. */
  state() { return this.stateToken; }

  /**
   * Called immediately after discovery and always before clientInformation(),
   * which is what makes issuer rebinding safe.
   */
  saveDiscoveryState(ds) {
    const discovered = String(ds?.authorizationServerUrl || '');
    if (!discovered) return;
    if (discovered !== getSecret(this.db, this.userId, this.issuerKey)) {
      setSecret(this.db, this.userId, this.issuerKey, discovered);
    }
    this.boundIssuer = discovered;
  }

  /** Let the SDK clear credentials the server has rejected. */
  invalidateCredentials(scope) {
    const fields = scope === 'all' ? ['clientInformation', 'tokens', 'codeVerifier']
      : scope === 'client' ? ['clientInformation']
      : scope === 'tokens' ? ['tokens']
      : scope === 'verifier' ? ['codeVerifier']
      : [];                                  // 'discovery' — nothing cached
    for (const f of fields) this._write(f, '');   // '' deletes (vault.mjs)
  }
}

// ─── OAuth-flow state map ───────────────────────────────────────────────────
//
// Mirrors connectors/slack-oauth.mjs: single-node, in-memory, TTL-swept.
// It carries only { userId, connectorId } — the credentials themselves live in
// the vault, so the callback rebuilds a provider from scratch instead of
// holding a live object across a browser round trip.

const _states = new Map();
function sweep() {
  const now = Date.now();
  for (const [k, v] of _states) if (now - v.createdAt > STATE_TTL_MS) _states.delete(k);
}
export function putMcpState(state, data) {
  sweep();
  _states.set(state, { ...data, status: 'pending', createdAt: Date.now() });
}
export function getMcpState(state) {
  const v = _states.get(state);
  if (!v) return undefined;
  if (Date.now() - v.createdAt > STATE_TTL_MS) { _states.delete(state); return undefined; }
  return v;
}
export function completeMcpState(state, patch) {
  const v = _states.get(state);
  if (v) _states.set(state, { ...v, ...patch });
}
/** Read the terminal status once, then drop it (single use). */
export function takeMcpStatus(state) {
  const v = _states.get(state);
  if (!v) return { status: 'unknown' };
  if (v.status !== 'pending') _states.delete(state);
  const out = { status: v.status };
  if (v.account !== undefined) out.account = v.account;
  if (v.message !== undefined) out.message = v.message;
  return out;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** True when this user holds tokens for this connector's current issuer. */
export function isMcpConnected(db, userId, def) {
  return Boolean(new VaultOAuthProvider({ db, userId, def }).tokens());
}

/**
 * Open a session, run `fn(client)`, close. Per call, never pooled.
 * Throws MCP_UNAUTHORIZED when the user has not connected — checked up front
 * so a sweep over unconnected users costs nothing and cannot trigger a
 * speculative dynamic client registration on every tick.
 */
export async function withMcpSession(db, userId, def, fn) {
  const provider = new VaultOAuthProvider({ db, userId, def });
  if (!provider.tokens()) throw mcpUnauthorized(def);

  const transport = new StreamableHTTPClientTransport(new URL(def.serverUrl), { authProvider: provider });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    await transport.close().catch(() => {});
    // The SDK already tried a refresh; reaching here means re-consent.
    if (err instanceof UnauthorizedError) throw mcpUnauthorized(def);
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Prove an authenticated round trip: connect + tools/list.
 *
 * `toolSchemas` is additive and load-bearing for setup: the descriptors'
 * Miro tool names and argument names are unverifiable offline, and this is
 * the only mechanical way to read the real ones off a live server.
 */
export async function testMcpConnection(db, userId, def) {
  return withMcpSession(db, userId, def, async (client) => {
    const { tools } = await client.listTools();
    return {
      server: client.getServerVersion() || { name: def.name, version: '' },
      tools: tools.map((t) => t.name),
      toolSchemas: tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema ?? null })),
    };
  });
}

// ─── Generic, descriptor-driven fetch ───────────────────────────────────────

/**
 * Unwrap a tools/call result into a JS value.
 *
 * Three layers, because real servers use all three:
 *   1. structuredContent — present when the tool declares an outputSchema
 *   2. JSON in a text block — the common case
 *   3. plain prose — legal, and a JSON.parse-only parser throws on it
 *
 * An `isError` result is a RESULT, not a rejection (the SDK server converts a
 * thrown handler into one), so a generic caller that does not check this flag
 * will happily parse an error message as content.
 */
export function parseToolResult(result) {
  if (result?.isError) {
    const text = (result.content || [])
      .filter((c) => c?.type === 'text').map((c) => c.text).join(' ').trim();
    const e = new Error(text.slice(0, 500) || 'the MCP tool reported an error');
    e.code = 'MCP_TOOL_ERROR';
    throw e;
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content || [])
    .filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function callMcpTool(client, name, args) {
  return parseToolResult(
    await client.callTool({ name, arguments: args || {} }, undefined, { timeout: TOOL_TIMEOUT_MS }),
  );
}

/**
 * Split `text` into pieces no longer than `maxChars`, preferring paragraph
 * boundaries, then line boundaries, then a hard cut.
 *
 * The hard cut is not defensive padding: a single tool result can be one
 * unbroken run (a serialised table, a minified export), and without it the cap
 * is advisory and the classify call downstream still gets the whole thing.
 *
 * Separators are preserved verbatim (`\n\n` between paragraphs, `\n` between
 * lines) so re-joining the chunks reproduces the input. Chunk N of a board
 * export is read by a human; silently reflowing it loses the structure the
 * paragraph split was chosen to respect in the first place.
 */
export function chunkText(text, maxChars = MAX_ITEM_CHARS) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= maxChars) return [s];

  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  const append = (piece, sep) => {
    if (cur && cur.length + sep.length + piece.length > maxChars) flush();
    cur = cur ? cur + sep + piece : piece;
  };

  const paras = s.split(/\n{2,}/);
  for (const [pi, para] of paras.entries()) {
    const paraSep = pi === 0 ? '' : '\n\n';
    if (para.length <= maxChars) { append(para, paraSep); continue; }
    for (const [li, line] of para.split('\n').entries()) {
      let rest = line;
      while (rest.length > maxChars) {          // hard cut
        flush();
        out.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      append(rest, li === 0 ? paraSep : '\n');
    }
  }
  flush();
  return out;
}

function mcpNotFetchable(def) {
  const e = new Error(`${def.name} has no fetch mapping configured yet.`);
  e.code = 'MCP_NOT_FETCHABLE';
  return e;
}

/** Mark item ids as imported for this user + connector. */
export function markMcpSeen(db, userId, def, itemIds) {
  return { marked: markMcpConnectorSeen(userId, def.id, itemIds) };
}

/**
 * The descriptor the mapper sees for a single-level source: its `listTool`
 * selectors promoted into the `readTool` slot the mapper reads. Still pure
 * descriptor data — nothing here knows which connector it is looking at.
 */
function singleLevelDef(def) {
  const list = def.listTool || {};
  return {
    ...def,
    readTool: {
      idField: list.idField || 'id',
      typeField: list.typeField || 'type',
      textFields: list.textFields || GENERIC_TEXT_FIELDS,
      dateField: list.dateField,
      linkField: list.linkField,
    },
  };
}

/**
 * One sweep: enumerate parents with `listTool`, read each with `readTool`,
 * map, drop anything already imported, chunk what is oversized, stop at the
 * cap. Entirely descriptor-driven — nothing here knows what Miro is.
 *
 * Failure isolation matches SlackSource.ingest: one unreadable parent (a
 * private board, an admin-revoked scope) is collected and skipped, never
 * allowed to abort the sweep — otherwise every scheduled run re-hits it first
 * and starves everything else.
 */
export async function fetchMcpItems(db, userId, def, { limit = DEFAULT_ITEM_LIMIT } = {}) {
  if (!def.listTool && !def.readTool) throw mcpNotFetchable(def);

  const seen = new Set(getMcpConnectorSeenIds(userId, def.id));
  const map = def.mapItem || defaultMcpItemMapper;
  const items = [];
  const failures = [];
  let overCap = 0;

  const collect = (records, parent, mapDef) => {
    for (const [index, record] of records.entries()) {
      let mapped;
      try {
        mapped = map({ def: mapDef, parent, item: record, index });
      } catch (e) {
        failures.push(`item ${index}: ${e.message}`);
        continue;
      }
      if (seen.has(mapped.id)) continue;

      const chunks = chunkText(mapped.body);
      if (chunks.length === 0) continue;              // nothing to write a note about
      for (const [k, body] of chunks.entries()) {
        if (items.length >= limit) { overCap += 1; continue; }
        const single = chunks.length === 1;
        items.push({
          // Each chunk is its own note AND its own dedup key, so a fetch
          // interrupted mid-item resumes at the right chunk rather than
          // re-importing the whole thing or skipping the remainder.
          id: single ? mapped.id : `${mapped.id}#${k + 1}`,
          fields: single
            ? mapped.fields
            : { ...mapped.fields,
              Part: `${k + 1}/${chunks.length}`,
              Title: `${mapped.fields.Title} (${k + 1}/${chunks.length})` },
          body,
        });
      }
    }
  };

  await withMcpSession(db, userId, def, async (client) => {
    let parents = [null];
    if (def.listTool) {
      const raw = await callMcpTool(client, def.listTool.name, { ...def.listTool.args });
      const all = toItemArray(raw, def.listTool.itemsPath);
      if (all.length > MAX_PARENTS) overCap += all.length - MAX_PARENTS;
      parents = all.slice(0, MAX_PARENTS);
    }

    if (!def.readTool) {
      // Single-level source: the list results ARE the content (gcal's
      // list_events, phase 3). No second call, no parent.
      collect(parents, null, singleLevelDef(def));
      return;
    }

    for (const parent of parents) {
      const args = { ...def.readTool.args };
      if (parent && def.readTool.parentArg) {
        args[def.readTool.parentArg] = pickPath(parent, def.listTool?.idField || 'id');
      }
      const label = parent
        ? String(pickPath(parent, def.listTool?.nameField || 'name')
                 ?? pickPath(parent, def.listTool?.idField || 'id') ?? '?')
        : def.name;
      try {
        collect(
          toItemArray(await callMcpTool(client, def.readTool.name, args), def.readTool.itemsPath),
          parent,
          def,
        );
      } catch (e) {
        failures.push(`${label}: ${e.message}`);
      }
    }
  });

  return { items, drained: overCap === 0 && failures.length === 0, overCap, failures };
}

/**
 * Begin authorization. Returns the URL for the Mac app to open, or
 * { alreadyConnected: true } when the saved tokens still work.
 */
export async function startMcpAuthorization({ db, userId, def, stateToken }) {
  const provider = new VaultOAuthProvider({ db, userId, def, stateToken });
  const transport = new StreamableHTTPClientTransport(new URL(def.serverUrl), { authProvider: provider });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return { authorizationUrl: null, alreadyConnected: true };
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    if (!provider.authorizationUrl) {
      // Unauthorized with nothing to open: discovery found no interactive
      // flow. Miro Enterprise disables MCP until an admin enables it, and
      // this is where that surfaces — as an error, not a silent empty fetch.
      throw new Error(`${def.name} did not offer an authorization URL — the server may have MCP access disabled for your plan.`);
    }
    return { authorizationUrl: provider.authorizationUrl, alreadyConnected: false };
  } finally {
    await transport.close().catch(() => {});
  }
}

/**
 * Exchange the authorization code and verify the result.
 *
 * finishAuth() needs a transport but never starts one, and a started transport
 * cannot be restarted — so the verification below uses a SECOND, fresh
 * transport. That is the SDK's documented sequence, not defensiveness.
 */
export async function finishMcpAuthorization({ db, userId, def, code }) {
  if (!code) throw new Error('Authorization code missing from the callback.');
  const provider = new VaultOAuthProvider({ db, userId, def });
  const authTransport = new StreamableHTTPClientTransport(new URL(def.serverUrl), { authProvider: provider });
  try {
    await authTransport.finishAuth(code);
  } finally {
    await authTransport.close().catch(() => {});
  }
  const info = await withMcpSession(db, userId, def, async (client) => client.getServerVersion());
  return { account: info?.name || def.name };
}
