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
const { handleLiveRoutes } = await import('../routes/live.mjs');
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

test('C7 defaults: capture mode starts at captions, and a closed panel warns on the page', async () => {
  const fs = await import('node:fs');
  const hook = fs.readFileSync(new URL('../src/sidepanel/hooks/useTranscript.ts', import.meta.url), 'utf8');
  assert.match(hook, /useState<CaptureMode>\('captions'\)/);
  const scraper = fs.readFileSync(new URL('../src/content/caption-scraper.ts', import.meta.url), 'utf8');
  assert.match(scraper, /LLM-IDE panel is closed; captions are not being saved/);
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('unlimitedStorage'));
});
