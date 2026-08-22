// Declarative descriptors for the MCP-backed ingestion connectors.
//
// Everything provider-specific lives here: where the server is, what scope to
// ask for, whether the operator must bring their own OAuth client, and (from
// phase 2b) which tool lists candidates, which tool reads one item, and how a
// tool result maps to { fields, body } for the inbox writer.
// connectors/mcp-client.mjs is entirely generic — it reads these fields and
// branches on nothing else. Adding a fourth MCP-backed connector should be an
// entry in this array plus a Mac manifest, and nothing else.
//
// Deliberately dependency-free: no vault, no config, no SDK. It is data.
//
// Phase 2a ships Miro alone. Miro supports RFC 7591 dynamic client
// registration, so there is zero operator setup — which is precisely why it
// goes first: it exercises discovery → DCR → PKCE → token → tools/list with
// nothing to configure. Phase 3 adds the Google pair, both byoClient: true
// because Google registers redirect URIs per client and offers no DCR:
//
//   Object.freeze({
//     id: 'gdrive', name: 'Google Drive',
//     serverUrl: 'https://drivemcp.googleapis.com/mcp/v1',
//     scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',
//     byoClient: true, clientName: CLIENT_NAME,
//     byoClientIdKey: 'mcp.gdrive.byoClientId',
//     byoClientSecretKey: 'mcp.gdrive.byoClientSecret',
//     listTool: 'search_files', readTool: 'read_file_content', mapItem: mapDriveFile,
//   }),
//
// byoClientIdKey / byoClientSecretKey name vault entries, so they must satisfy
// server/vault.mjs's MCP_CREDENTIAL_KEY_RE (`mcp.<slug>.<field>`). They are
// NOT issuer-scoped like the runtime credentials in mcp-client.mjs: an
// operator-provisioned client belongs to the descriptor, not to a discovered
// authorization server.

const CLIENT_NAME = 'LLM-IDE';

export const MCP_CONNECTOR_DEFS = Object.freeze([
  Object.freeze({
    id: 'miro',
    name: 'Miro',
    serverUrl: 'https://mcp.miro.com',
    // Requested scope. When the server advertises `scopes_supported` in its
    // RFC 9728 protected-resource metadata the SDK prefers that (SEP-835);
    // this is the fallback for servers that advertise nothing.
    scope: 'boards:read',
    byoClient: false,               // dynamic client registration
    clientName: CLIENT_NAME,
    byoClientIdKey: 'mcp.miro.byoClientId',
    byoClientSecretKey: 'mcp.miro.byoClientSecret',
    // Phase 2b: the fetch pipeline.
    listTool: null,
    readTool: null,
    mapItem: null,
  }),
]);

export const MCP_CONNECTOR_IDS = Object.freeze(MCP_CONNECTOR_DEFS.map((d) => d.id));

// Test/staging seam: LLMIDE_MCP_<ID>_URL repoints one connector's server
// without a code change. Read on EVERY call, never memoised — tests start an
// ephemeral fixture on port 0 and can only set the variable afterwards.
//
// Only https (any host) or http on the loopback interface is honoured. An
// operator who can set our environment has already won, but this keeps a
// typo from aiming an authenticated connector at an arbitrary LAN host.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function overrideServerUrl(id) {
  const raw = process.env[`LLMIDE_MCP_${id.toUpperCase().replace(/-/g, '_')}_URL`];
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u.toString();
  return null;
}

/** The descriptor for `id` with any server-URL override applied, or null. */
export function mcpConnectorDef(id) {
  if (typeof id !== 'string' || !id) return null;
  const base = MCP_CONNECTOR_DEFS.find((d) => d.id === id);
  if (!base) return null;
  const override = overrideServerUrl(base.id);
  return override ? Object.freeze({ ...base, serverUrl: override }) : base;
}
