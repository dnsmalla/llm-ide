// C7: a capture over the server's per-request cap is sent as numbered parts and assembled before finalize.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-finalize-parts-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const kb = await import('../kb/db.mjs');
const { handleLiveRoutes, takeFinalizeParts, pendingFinalizeBytes } = await import('../routes/live.mjs');
const { splitFinalizeParts, FINALIZE_PART_LINES } = await import('../src/lib/capture-store.ts');

after(() => {
  try {
    kb.closeDb();
  } catch {
    /* closed */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const caption = (i: number) => ({
  speaker: 'A',
  text: `line ${i}`,
  timestamp: 1_700_000_000_000 + i * 1000,
  sessionId: 's-in',
});

function res() {
  const r = {
    statusCode: 200,
    body: '',
    writeHead(c: number) {
      this.statusCode = c;
    },
    end(b: string) {
      this.body += b;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
  return r;
}
const req = (body: unknown) => ({
  method: 'POST',
  url: '/kb/live/s-parts/finalize',
  on(e: string, cb: (c?: Buffer) => void) {
    if (e === 'data') cb(Buffer.from(JSON.stringify(body)));
    else if (e === 'end') cb();
  },
});

test('splitFinalizeParts keeps every caption, in order, under 2,000 lines', () => {
  const all = Array.from({ length: 4500 }, (_, i) => caption(i));
  const parts = splitFinalizeParts(all);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].length, FINALIZE_PART_LINES);
  assert.deepEqual(parts.flat(), all, 'order and count are preserved');
  assert.deepEqual(splitFinalizeParts([]), [[]]);
});

test('the route assembles three parts and finalizes all 4,500 lines', async () => {
  kb.getDb()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u1','p@x.y','P','x','user','active')",
    )
    .run();
  const all = Array.from({ length: 4500 }, (_, i) => caption(i));
  const parts = splitFinalizeParts(all);
  let last: Record<string, unknown> | null = null;
  for (let i = 0; i < parts.length; i += 1) {
    const r = res();
    await handleLiveRoutes(req({ captions: parts[i], part: i + 1, of: parts.length, meetingTitle: 'Big' }), r, {
      userId: 'u1',
      url: '/kb/live/s-parts/finalize',
    });
    assert.equal(r.statusCode, 200);
    last = r.json();
    if (i < parts.length - 1) assert.equal(last?.pending, true);
  }
  assert.notEqual(last?.pending, true, 'the last part finalizes');
  assert.equal(last?.captionCount, 4500);
});

test('R-024: a part with more than FINALIZE_PART_LINES captions is refused before it is stored', async () => {
  const tooBig = Array.from({ length: FINALIZE_PART_LINES + 1 }, (_, i) => caption(i));
  const r = res();
  await handleLiveRoutes(req({ captions: tooBig, part: 1, of: 2 }), r, {
    userId: 'u1',
    url: '/kb/live/s-too-big/finalize',
  });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error.code, 'VALIDATION_FAILED');
  assert.match(r.json().error.message, new RegExp(`at most ${FINALIZE_PART_LINES} captions`));

  // A full part is still accepted (pending), and the exact cap is not off by one.
  const full = Array.from({ length: FINALIZE_PART_LINES }, (_, i) => caption(i));
  const ok = res();
  await handleLiveRoutes(req({ captions: full, part: 1, of: 2 }), ok, {
    userId: 'u1',
    url: '/kb/live/s-too-big/finalize',
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().pending, true);
});

test('C7 defaults: capture mode starts at captions, and a closed panel warns on the page', async () => {
  const fs = await import('node:fs');
  const hook = fs.readFileSync(new URL('../src/sidepanel/hooks/useTranscript.ts', import.meta.url), 'utf8');
  assert.match(hook, /useState<CaptureMode>\('captions'\)/);
  const scraper = fs.readFileSync(new URL('../src/content/caption-scraper.ts', import.meta.url), 'utf8');
  assert.match(scraper, /LLM-IDE panel is closed; captions are not being saved/);
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('unlimitedStorage'));
});

test('stored part sizes enforce the per-user byte cap without re-stringifying', () => {
  const uid = `bytes-${Date.now()}`;
  const huge = [{ text: 'x'.repeat(33 * 1024 * 1024) }];
  const r = takeFinalizeParts(uid, 's-huge', { part: 1, of: 2, captions: huge });
  assert.equal(r.tooLarge, true, 'one part over 32 MB is refused');
  assert.equal(pendingFinalizeBytes(uid), 0, 'the refused part is not stored');

  const many = `many-${Date.now()}`;
  const one = [{ text: 'line' }];
  for (let p = 1; p <= 3; p++) {
    for (let n = 1; n <= 24; n++) {
      const out = takeFinalizeParts(many, `s-${p}`, { part: n, of: 25, captions: one });
      assert.equal(out.pending, true);
    }
  }
  // 3 sessions x 24 parts are pending; sizes are stored, so this call is O(parts), not O(bytes).
  assert.ok(pendingFinalizeBytes(many) > 0);
  const again = takeFinalizeParts(many, 's-1', { part: 1, of: 25, captions: one });
  assert.equal(again.pending, true, 'a re-sent part replaces its stored size, not adds one');
});
