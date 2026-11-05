// Runs the REAL caption-scraper.ts against saved DOM fixtures in Node (happy-dom).
// MutationObserver/rAF are stubbed and timers are mocked so scrapes are driven
// by explicit tick() calls instead of real 800 ms waits.
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';

register('./ts-src-hooks.mjs', import.meta.url);

export interface Sent {
  type: string;
  speaker?: string;
  text?: string;
  sessionId?: string;
}

const URLS = {
  meet: 'https://meet.google.com/abc-defg-hij',
  teams: 'https://teams.microsoft.com/v2/',
  zoom: 'https://app.zoom.us/wc/123456789/join',
} as const;
export type Platform = keyof typeof URLS;

let n = 0;
export async function createHarness(platform: Platform, url: string = URLS[platform]) {
  const win = new Window({ url });
  const sent: Sent[] = [];
  let listener: ((m: unknown, s: { id: string }, r: (x: unknown) => void) => unknown) | null = null;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.CustomEvent = win.CustomEvent; // window.dispatchEvent rejects Node's CustomEvent
  g.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = () => 0;
  g.chrome = {
    runtime: {
      id: 'test-ext',
      sendMessage: (m: Sent) => (sent.push(m), Promise.resolve()),
      onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
    },
  };
  mock.timers.reset();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  await import(`../../src/content/caption-scraper.ts?h=${n++}`);
  const send = (type: string) => listener!({ type }, { id: 'test-ext' }, () => {});
  return {
    sent,
    captions: () => sent.filter((m) => m.type === 'CAPTION_FINAL'),
    start: () => send('START_CAPTION_SCRAPING'),
    stop: () => send('STOP_CAPTION_SCRAPING'),
    load(name: string) {
      const html = readFileSync(new URL(`../fixtures/captions/${platform}/${name}.html`, import.meta.url), 'utf8');
      win.document.body.innerHTML = html;
    },
    loadHtml(html: string) {
      win.document.body.innerHTML = html;
    },
    tick: (ms = 800) => mock.timers.tick(ms),
    close() {
      mock.timers.reset();
      win.close();
    },
  };
}
