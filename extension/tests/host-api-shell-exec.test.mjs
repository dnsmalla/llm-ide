import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellExec } from '../routes/host-api/shell-exec.mjs';

test('runs a shell command in the project root', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-shell-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = await shellExec(root, { command: 'printf "a\\nb\\n" | sort' });
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, 'a\nb\n');
});

test('refuses an empty or oversized command', async () => {
  await assert.rejects(() => shellExec('/tmp', { command: '   ' }), /not valid/);
  await assert.rejects(() => shellExec('/tmp', { command: 'x'.repeat(2001) }), /not valid/);
});
