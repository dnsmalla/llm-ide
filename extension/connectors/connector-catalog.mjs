// Curated connector catalog — the Library's "Add from catalog…" list.
// Mirror of extension/mcp/catalog.mjs: a frozen, code-reviewed list; adding
// a connector is a deliberate product decision, not data entry.
//
// pipelineReady marks whether the fetch→folder→llm-doc pipeline exists:
// true only for connectors that already work today. The new three (gdrive,
// gcal, miro) flip to true in phases 2–3 of the connector-catalog spec.
//
// icon is an SF Symbol name; the Mac app renders it directly.
export const CONNECTOR_CATALOG = Object.freeze([
  Object.freeze({
    id: 'gdrive', name: 'Google Drive',
    description: 'Fetch files from Drive folders into llm-doc notes.',
    icon: 'externaldrive.fill.badge.icloud', authKind: 'google-oauth',
    docsUrl: 'https://developers.google.com/drive/api/guides/enable-sdk',
    pipelineReady: false,
  }),
  Object.freeze({
    id: 'gcal', name: 'Google Calendar',
    description: 'Fetch recent and upcoming calendar events into llm-doc notes.',
    icon: 'calendar', authKind: 'google-oauth',
    docsUrl: 'https://developers.google.com/calendar/api/quickstart/js',
    pipelineReady: false,
  }),
  Object.freeze({
    id: 'miro', name: 'Miro',
    description: 'Fetch board text content (stickies, text items) into llm-doc notes.',
    icon: 'square.grid.3x3', authKind: 'miro-oauth',
    docsUrl: 'https://developers.miro.com/docs',
    pipelineReady: false,
  }),
  Object.freeze({
    id: 'box', name: 'Box',
    description: 'Index a Box folder into the searchable knowledge base.',
    icon: 'externaldrive.fill', authKind: 'box-ccg',
    docsUrl: 'https://developer.box.com/guides/',
    pipelineReady: true,
  }),
  Object.freeze({
    id: 'slack', name: 'Slack',
    description: 'Fetch channel history into llm-doc notes.',
    icon: 'message.fill', authKind: 'slack-oauth',
    docsUrl: 'https://api.slack.com/authentication',
    pipelineReady: true,
  }),
]);

/** The catalog entry with `id`, or null. */
export function catalogEntry(id) {
  return CONNECTOR_CATALOG.find((e) => e.id === id) || null;
}
