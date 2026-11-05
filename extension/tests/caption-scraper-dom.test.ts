// Browser-level caption capture: the real scraper runs against saved caption
// DOM fixtures (tests/fixtures/captions/<platform>/). A meeting site changing
// its caption DOM fails here instead of in a real meeting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Platform } from './helpers/caption-harness.ts';

const PLATFORMS: Platform[] = ['meet', 'teams', 'zoom'];

async function run(platform: Platform, names: string[]) {
  const h = await createHarness(platform);
  h.start();
  for (const n of names) {
    h.load(n);
    h.tick();
  }
  const out = h.captions();
  h.close();
  return out;
}

for (const p of PLATFORMS) {
  test(`${p}: platform detected, START announces it`, async () => {
    const h = await createHarness(p);
    h.start();
    const status = h.sent.find((m) => m.type === 'CAPTION_STATUS') as unknown as { platform: string };
    h.close();
    assert.equal(status.platform, p);
  });

  test(`${p}: basic caption captured with speaker and text`, async () => {
    const c = await run(p, ['basic']);
    assert.deepEqual(c.map((m) => [m.speaker, m.text]), [['Alice Example', "Let's start."]]);
  });

  test(`${p}: Japanese short caption is kept`, async () => {
    const c = await run(p, ['japanese']);
    assert.deepEqual(c.map((m) => [m.speaker, m.text]), [['山田 太郎', 'はい。']]);
  });

  test(`${p}: UI noise (toolbar, clock, meeting id) is ignored`, async () => {
    assert.deepEqual(await run(p, ['noise']), []);
  });

  test(`${p}: unchanged text is not re-sent`, async () => {
    const c = await run(p, ['basic', 'basic', 'basic']);
    assert.equal(c.length, 1);
  });

  test(`${p}: long multi-sentence update stays on one line (same sessionId)`, async () => {
    const c = await run(p, ['basic', 'long']);
    assert.equal(c.length, 2);
    assert.equal(c[0].sessionId, c[1].sessionId);
    assert.match(c[1].text!, /^Thanks everyone for joining\. .*hiring plan for next quarter\.$/);
  });

  test(`${p}: combined-speaker suffix stripped`, async () => {
    const c = await run(p, ['combined', 'combined-ja']);
    assert.deepEqual(c.map((m) => m.speaker), ['Alice Example', '山田 太郎']);
  });

  test(`${p}: two speakers get distinct lines; a speaker change starts a new line`, async () => {
    const c = await run(p, ['two-speakers', 'speaker-change']);
    assert.deepEqual(c.map((m) => m.speaker).sort(), ['Alice Example', 'Bob Sample']);
    assert.notEqual(c[0].sessionId, c[1].sessionId);
  });

  test(`${p}: silence over 5 s then speech starts a new line`, async () => {
    const h = await createHarness(p);
    h.start();
    h.load('basic');
    h.tick();
    h.load('noise');
    h.tick(6_000);
    h.load('basic');
    h.tick();
    const c = h.captions();
    h.close();
    assert.equal(c.length, 2);
    assert.notEqual(c[0].sessionId, c[1].sessionId);
  });
}

test('meet: noise inside real caption blocks is rejected, the genuine caption is kept', async () => {
  const c = await run('meet', ['noise-and-caption']);
  assert.deepEqual(c.map((m) => [m.speaker, m.text]), [['Bob Sample', 'Sounds good to me.']]);
});

const block = {
  meet: (s: string, t: string) => `<div class="nMcdL bj4p3b"><div class="adE6rb">${s}</div><div class="ygicle">${t}</div></div>`,
  teams: (s: string, t: string) =>
    `<div data-tid="closed-caption-chat-message"><span class="ui-chat__message__author">${s}</span><div data-tid="closed-caption-text">${t}</div></div>`,
  zoom: (s: string, t: string) => `<li class="transcript-message"><div class="speaker">${s}</div><div class="text">${t}</div></li>`,
};
const wrap = {
  meet: (b: string) => `<div class="nMcdL bj4p3b">${b}</div>`,
  teams: (b: string) => `<div id="caption-list">${b}</div>`,
  zoom: (b: string) => `<div aria-label="Transcript"><ul>${b}</ul></div>`,
};

for (const p of PLATFORMS) {
  test(`${p}: interleaved speakers keep their own line; only changed text is re-sent`, async () => {
    const h = await createHarness(p);
    h.start();
    const A1 = "Let's start the review.";
    const A2 = `${A1} First up is the budget.`;
    const B1 = 'Sounds good to me.';
    const render = (a: string, b?: string) =>
      h.loadHtml(wrap[p](block[p]('Alice Example', a) + (b ? block[p]('Bob Sample', b) : '')));
    render(A1);
    h.tick();
    render(A1, B1);
    h.tick();
    render(A1, B1); // nothing changed: no re-send
    h.tick();
    render(A2, B1); // Alice grows within 5 s
    h.tick();
    const c = h.captions();
    h.close();
    assert.deepEqual(c.map((m) => [m.speaker, m.text]), [
      ['Alice Example', A1],
      ['Bob Sample', B1],
      ['Alice Example', A2],
    ]);
    assert.equal(c[0].sessionId, c[2].sessionId);
    assert.notEqual(c[0].sessionId, c[1].sessionId);
  });
}

test('meet: non-meeting page (landing) never starts capture', async () => {
  const h = await createHarness('meet', 'https://meet.google.com/landing');
  h.start();
  h.load('basic');
  h.tick();
  const c = h.captions();
  h.close();
  assert.deepEqual(c, []);
});
