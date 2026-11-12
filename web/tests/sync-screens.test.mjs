// The sync tier renders: labelled inputs, the spoken SAS, staleness and offline banners, meetings and plans from the
// snapshot through ReadPanel, and every storage string as text.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi, h, html } from './helpers.mjs';

let UI;
before(async () => { UI = await loadUi(); });
const noop = () => {};
const sync = { pair: noop, cancelPairing: noop, unlock: noop, send: async () => true, refresh: noop, lock: noop, forget: noop };
const S = { phase: 'ready', pairStep: null, sas: null, busy: false, error: null, notice: null, online: true, email: 'sync@example.com',
  snapshot: null, stale: false, checkedAt: null, pending: [], answered: [] };
const snap = { generatedAt: 1762400000000, validUntil: 1762402700000, manifestSeq: 9, kinds: {
  chats: { v: 1, kind: 'chats', generatedAt: 1, truncated: false, items: [{ id: 'c1', title: 'Router plan', updatedAt: 1, phoneChat: true, messages: [{ seq: 1, role: 'user', content: 'hi' }] }] },
  meetings: { v: 1, kind: 'meetings', generatedAt: 1, truncated: false, items: [{ id: 'm1', title: 'Standup', date: '2026-11-05', durationSec: 900, participants: ['Ana'], notes: [{ kind: 'decision', text: 'Ship it' }] }] },
  plans: { v: 1, kind: 'plans', generatedAt: 1, truncated: false, items: [{ id: 'p1', title: 'Launch', goal: 'Go live', updatedAt: 1, tasks: [{ title: 'Write docs', status: 'open', owner: 'Dee', due: '2026-11-09', milestone: '', risk: '' }] }] },
  usage: { v: 1, kind: 'usage', generatedAt: 1, truncated: false, items: [{ providers: [] }] } } };
const view = (state, hostPaired = false) => html(h(UI.SyncTier, { state: { ...S, ...state }, sync, hostPaired }));

test('pairing form: labelled name, email and password; password never stored is said; no PIN', () => {
  const out = view({ phase: 'pairing' });
  for (const l of ['Name for this browser', 'MEGA email', 'MEGA password']) assert.match(out, new RegExp(`<label[^>]*>${l}</label>`));
  assert.match(out, /type="password"/);
  assert.match(out, /autoComplete="current-password"|autocomplete="current-password"/);
  assert.match(out, /never stored/);
});

test('SAS: grouped digits with a spoken label and a live status', () => {
  const out = view({ phase: 'pairing', pairStep: 'sas', sas: '123456' });
  assert.match(out, /123 456/);
  assert.match(out, /aria-label="Pairing code 1 2 3 4 5 6"/);
  assert.match(out, /role="status"/);
  assert.match(out, /Codes match/);
});

test('locked: unlock form with the remembered email; removed: explanation and Forget', () => {
  const locked = view({ phase: 'locked' });
  assert.match(locked, /value="sync@example.com"/);
  assert.match(locked, /Unlock/);
  assert.match(view({ phase: 'removed' }), /removed from sync/);
  assert.match(view({ phase: 'removed' }), /Forget this browser/);
});

test('ready: last seen, stale and offline banners, chats (phone chat openable), meetings, plans, inbox', () => {
  const out = view({ snapshot: snap, stale: true, online: false }, true);
  assert.match(out, /Desktop last seen/);
  assert.match(out, /Desktop offline or storage withholding updates/);
  assert.match(out, /You are offline/);
  assert.match(out, /Desktop not reachable/);
  assert.match(out, /<button[^>]*>(?:(?!<\/button>).)*Router plan/);
  assert.match(out, /Standup/); assert.match(out, /Ship it/);
  assert.match(out, /Write docs/); assert.match(out, /Go live/);
  assert.match(out, /<label[^>]*>Prompt for the desktop<\/label>/);
  assert.match(out, /maxLength="4000"|maxlength="4000"/);
  assert.match(out, /read-only/);
});

test('a truncated snapshot says only the most recent items are on this device', () => {
  const truncated = { ...snap, kinds: { ...snap.kinds, meetings: { ...snap.kinds.meetings, truncated: true } } };
  assert.match(view({ snapshot: truncated }), /Only the most recent items are on this device\./);
  assert.doesNotMatch(view({ snapshot: snap }), /Only the most recent items/);
});

test('queued and answered prompts render as text; error codes read as sentences', () => {
  const out = view({ snapshot: snap, pending: [{ requestId: 'r1', issuedAt: 1, text: '<b>q</b>' }],
    answered: [{ requestId: 'r2', issuedAt: 1, text: null, ok: true, reply: '<img src=x onerror=alert(1)>', code: null },
      { requestId: 'r3', issuedAt: 1, text: 'later', ok: false, reply: null, code: 'needs_approval' }] });
  assert.doesNotMatch(out, /<img|<b>q/);
  assert.match(out, /&lt;b&gt;q&lt;\/b&gt;/);
  assert.match(out, new RegExp(UI.REPLY_TEXT.needs_approval.slice(0, 20)));
});

test('the paste-a-link form is labelled', () => {
  const out = html(h(UI.SyncLinkEntry, { onLink: () => true, error: null }));
  assert.match(out, /<label[^>]*>Pairing link<\/label>/);
});

test('snapshotReadState maps chats, usage, meetings and plans; the Host API state has none of the last two', () => {
  const r = UI.snapshotReadState(snap, 'c1');
  assert.equal(r.sessions[0].phoneChat, undefined);
  assert.equal(r.open.messages[0].content, 'hi');
  assert.equal(r.open.nextBeforeSeq, null);
  assert.deepEqual(r.usage, []);
  assert.equal(r.meetings[0].title, 'Standup');
  assert.equal(UI.initialReadState.meetings, null);
  assert.equal(UI.initialReadState.plans, null);
});
