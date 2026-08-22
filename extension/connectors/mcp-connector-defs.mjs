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
    // ── Phase 2b: the fetch pipeline ───────────────────────────────────────
    //
    // ⚠ UNVERIFIED. Miro's real MCP tool names and argument names cannot be
    // checked offline — there is no vendored schema and no test may contact
    // mcp.miro.com. Everything below is an educated guess from the published
    // capability list ("board read: sticky notes, shapes, frames, text,
    // cards, tables, comments").
    //
    // To CONFIRM or CORRECT: connect Miro, then
    //   POST /kb/mcp-connector/test { "id": "miro" }
    // whose response carries `tools` (real names) and `toolSchemas` (real
    // argument names). Fixing a wrong guess is editing the string literals
    // below and nothing else — no code path branches on them.
    //
    // Every selector is tolerant (see toItemArray / pickText): a wrong path
    // degrades to a rawer note, never to an empty fetch.
    listTool: Object.freeze({
      name: 'list_boards',        // ⚠ guess
      args: Object.freeze({}),    // static extra arguments, if any
      itemsPath: 'data',          // where the array lives in the parsed result
      idField: 'id',
      nameField: 'name',
    }),
    readTool: Object.freeze({
      name: 'get_board_items',    // ⚠ guess
      parentArg: 'board_id',      // ⚠ guess — carries the listTool item's id
      args: Object.freeze({}),
      itemsPath: 'data',
      idField: 'id',
      typeField: 'type',
      // Tried in order; the first non-blank wins. Covers the shapes Miro's
      // REST API uses for stickies, text, cards, shapes and comments.
      textFields: Object.freeze([
        'data.content', 'data.title', 'data.plainText', 'data.description',
        'text', 'content', 'title', 'plainText',
      ]),
      dateField: 'modifiedAt',
      linkField: 'links.self',
    }),
    // `defaultMcpItemMapper` is a hoisted function declaration at the bottom
    // of this file, so naming it here — inside the frozen literal — is legal.
    // It must be done here: Object.freeze makes properties non-writable AND
    // non-configurable, so patching the slot in afterwards would throw.
    mapItem: defaultMcpItemMapper,
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

// ─── Generic tool-result shaping ────────────────────────────────────────────
//
// These exist so a descriptor is DATA. Everything a provider varies — where
// the array is, which key holds the text, what the id field is called — is a
// string in the table above, and these functions consume those strings.
//
// The design rule throughout: a wrong guess DEGRADES. Miro's tool surface is
// not verifiable from this repo, so the failure mode that matters is not "the
// mapping is imperfect" (fixable in a minute) but "the fetch silently returned
// nothing" (indistinguishable from an empty board, and expensive to diagnose).

/** Read a dotted path out of a plain object. undefined on any miss — never throws. */
export function pickPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Array elements that are null/undefined are holes, not records — a note
 *  whose whole body is the string "null" is worse than no note at all. */
function compactRecords(arr) {
  return arr.filter((v) => v != null);
}

/**
 * The array of records inside a parsed tool result, with four fallbacks in
 * descending order of confidence:
 *   1. the declared itemsPath resolves to an array   — the guess was right
 *   2. the result IS an array                        — server returned bare
 *   3. the first NON-EMPTY array-valued property      — itemsPath was misnamed
 *   4. the result is a single object                  — a one-item result
 * A non-object, non-empty result becomes one text item rather than vanishing.
 *
 * Tier 3 skips empty arrays deliberately: `{ errors: [], boards: [...] }` and
 * `{ warnings: [], items: [...] }` are ordinary envelope shapes, and taking
 * the literal first array would return the empty status channel and report a
 * silent empty fetch — the exact failure this tolerant design exists to avoid.
 * An empty array is still returned when it is the only array there is, so a
 * genuinely empty source stays empty.
 */
export function toItemArray(parsed, itemsPath) {
  const atPath = pickPath(parsed, itemsPath);
  if (Array.isArray(atPath)) return compactRecords(atPath);
  if (Array.isArray(parsed)) return compactRecords(parsed);
  if (parsed && typeof parsed === 'object') {
    let empty = null;
    for (const v of Object.values(parsed)) {
      if (!Array.isArray(v)) continue;
      const records = compactRecords(v);
      if (records.length) return records;
      if (empty === null) empty = records;
    }
    if (empty) return empty;
    return [parsed];
  }
  if (parsed == null || parsed === '') return [];
  return [{ text: String(parsed) }];
}

// Keys that are plumbing rather than content. Excluded from the last-resort
// JSON dump so a mis-guessed textFields still yields a readable note.
const META_KEYS = new Set([
  'id', 'type', 'createdAt', 'modifiedAt', 'createdBy', 'modifiedBy',
  'links', 'parent', 'geometry', 'position', 'style', 'widgetType',
]);

/** First non-blank value among `candidates`; a metadata-stripped dump otherwise. */
export function pickText(item, candidates) {
  for (const p of candidates || []) {
    const v = pickPath(item, p);
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  if (typeof item === 'string') return item;
  const rest = {};
  for (const [k, v] of Object.entries(item || {})) if (!META_KEYS.has(k)) rest[k] = v;
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : JSON.stringify(item ?? null);
}

/**
 * Unwrap the small HTML subset board tools return in sticky/text content.
 * Not a sanitiser and not trying to be — the output is a plain-text note body
 * written to disk, never rendered as markup.
 */
export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // A non-breaking space usually sits next to a real one in board markup
    // ("&amp;&nbsp;co"), so absorb one adjacent space rather than emitting a
    // double. Deliberately narrow: a blanket horizontal-whitespace collapse
    // would also wreck the indentation of pickText's JSON-dump fallback.
    .replace(/[ \t]?&nbsp;[ \t]?/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')            // last, so &amp;lt; does not become <
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function normalizeDate(v) {
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // The inbox writer needs a Date header to name and order the raw file; an
  // item with no timestamp is "now" rather than 1970.
  return new Date().toISOString();
}

/**
 * The one mapper every MCP connector uses until one genuinely needs its own.
 * Reads nothing but the descriptor's `listTool`/`readTool` strings, so
 * retargeting it at a different provider is a table edit.
 *
 * The returned `id` is the dedup key written to mcp_connector_seen, so it must
 * be STABLE across runs and UNIQUE across parents. `<connector>:<parent>:<item>`
 * satisfies both; `idx<n>` is the positional fallback for items a server
 * returns without an id of their own.
 */
export function defaultMcpItemMapper({ def, parent, item, index = 0 }) {
  const list = def.listTool || {};
  const read = def.readTool || {};

  const parentId = parent ? String(pickPath(parent, list.idField || 'id') ?? '') : '';
  const parentName = parent
    ? String(pickPath(parent, list.nameField || 'name') ?? parentId ?? def.name)
    : def.name;

  const rawId = String(pickPath(item, read.idField || 'id') ?? '');
  const id = [def.id, parentId, rawId || `idx${index}`].filter(Boolean).join(':');

  const itemType = String(pickPath(item, read.typeField || 'type') ?? 'item');
  const body = stripHtml(pickText(item, read.textFields));
  const link = String(pickPath(item, read.linkField) ?? '');

  return {
    id,
    // These keys are the contract with the Mac manifest's `rawHeaders` map.
    // Changing one here means changing it in the manifest JSON too.
    // `ItemId` is deliberately absent: the server returns the id alongside
    // the fields, and the Mac adapter injects it (see McpConnectorAdapter).
    fields: {
      Title: parentName ? `${parentName} — ${itemType}` : itemType,
      Board: parentName,
      ItemType: itemType,
      Date: normalizeDate(pickPath(item, read.dateField)),
      Link: link,
    },
    body,
  };
}
