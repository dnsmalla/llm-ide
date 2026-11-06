// The sources screen renders: labelled setup fields with the redirect URI and read-only scopes, breadcrumbs with the
// current place, a labelled search, entries as buttons, and file bodies as text only (no HTML, no frames for PDFs).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi, h, html } from './helpers.mjs';

let UI;
before(async () => { UI = await loadUi(); });
const noop = async () => {};
const sources = { configure: async () => true, forgetConfig: noop, signIn: noop, signOut: noop, choose: noop, openEntry: noop, toCrumb: noop, more: noop,
  search: noop, clearSearch: noop, closeFile: () => {}, redirectUri: () => 'https://llm-ide.com/app/oauth-callback.html' };
const S = { loaded: true, configured: { gitlab: false, box: false }, signedIn: { gitlab: false, box: false }, provider: null, online: true, busy: false,
  status: '', error: null, trail: [], entries: [], next: null, query: null, opened: null };
const view = (state) => html(h(UI.SourcesScreen, { state: { ...S, ...state }, sources, onBack: () => {} }));
const proj = { id: 'p7', name: 'demo', kind: 'project', path: 'dee/demo', size: null, detail: null, project: { id: 7, ref: 'main', webUrl: 'https://gitlab.com/dee/demo' } };
const file = (name, extra = {}) => ({ entry: { id: `7:${name}`, name, kind: 'file', path: `src/${name}`, size: null, detail: null, project: proj.project },
  kind: 'code', language: 'typescript', text: null, bytes: null, truncated: false, webUrl: 'https://gitlab.com/dee/demo/-/blob/main/src/' + name, reason: null, ...extra });

test('setup cards: labelled fields, password-type Box secret, redirect URI and read-only scopes stated', () => {
  const out = view({});
  for (const l of ['Application ID', 'Client ID', 'Client secret']) assert.match(out, new RegExp(`<label[^>]*>${l}</label>`));
  assert.match(out, /type="password"/);
  assert.match(out, /https:\/\/llm-ide\.com\/app\/oauth-callback\.html/);
  assert.match(out, /read_api and read_repository/);
  assert.match(out, /Read all files and folders/);
  assert.match(out, /read-only/);
  assert.match(view({ configured: { gitlab: true, box: false } }), /Sign in to GitLab/);
  assert.match(view({ configured: { gitlab: true, box: false }, signedIn: { gitlab: true, box: false } }), /Browse/);
});

test('browser: breadcrumbs with aria-current, labelled search with role=search, entries as buttons, More', () => {
  const out = view({ provider: 'gitlab', signedIn: { gitlab: true, box: false }, trail: [proj], next: '2',
    entries: [{ id: '7:src', name: 'src', kind: 'dir', path: 'src', size: null, detail: null, project: proj.project }] });
  assert.match(out, /<nav aria-label="Location">/);
  assert.match(out, /aria-current="page"[^>]*>demo<\/button>/);
  assert.match(out, /role="search"/);
  assert.match(out, /<label[^>]*>Search code in this project<\/label>/);
  assert.match(out, /<button[^>]*class="web-entry"[^>]*>[^<]*<span class="chat-muted">Folder<\/span> src<\/button>/);
  assert.match(out, />More<\/button>/);
  assert.match(view({ provider: 'box', signedIn: { gitlab: false, box: true } }), /<label[^>]*>Search Box files<\/label>/);
});

test('file view: code is escaped text in a focusable labelled pre; markdown renders no raw HTML', () => {
  const code = view({ provider: 'gitlab', opened: file('app.ts', { text: '<script>alert(1)</script>' }) });
  assert.match(code, /<pre class="web-src" tabindex="0" aria-label="Contents of app\.ts"><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.match(code, /<h2 tabindex="-1">app\.ts<\/h2>/);
  assert.match(code, /Open on GitLab/);
  assert.match(code, /read-only/);
  const md = view({ provider: 'gitlab', opened: file('README.md', { kind: 'markdown', language: 'Markdown', text: '# Hi\n\n<img src=x onerror=alert(1)>' }) });
  assert.doesNotMatch(md, /<img|<script/);
  assert.match(md, /<h1>Hi<\/h1>/);
});

test('file view: PDF offered as a download only; truncated, binary and missing-text notices', () => {
  const pdf = view({ provider: 'box', opened: file('deck.pdf', { kind: 'pdf', language: 'PDF', bytes: new Uint8Array(2048) }) });
  assert.match(pdf, />Save PDF<\/button>/);
  assert.doesNotMatch(pdf, /<iframe|<embed|<object/);
  assert.match(view({ provider: 'gitlab', opened: file('big.txt', { kind: 'text', text: 'a', truncated: true }) }), /Only the first part is shown/);
  assert.match(view({ provider: 'gitlab', opened: file('logo.bin', { kind: 'unsupported', reason: 'binary' }) }), new RegExp(UI.REASON.binary));
  assert.match(view({ provider: 'box', opened: file('scan.docx', { kind: 'unsupported', reason: 'no_text' }) }), new RegExp(UI.REASON.no_text));
  const ex = view({ provider: 'box', opened: file('plan.docx', { kind: 'extracted', text: 'Plan' }) });
  assert.match(ex, /Text extracted by Box/);
});

test('offline banner, live status and error alert', () => {
  const out = view({ online: false, status: 'Loading…', error: 'The provider refused access to this item.' });
  assert.match(out, /You are offline/);
  assert.match(out, /role="status" aria-live="polite">Loading…/);
  assert.match(out, /role="alert"/);
});
