import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './helpers.mjs';

test('the process entry starts, answers /health and exits on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'accounts-bin-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/account-service.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, ACCOUNTS_PORT: '0', ACCOUNTS_DB_PATH: join(dir, 'accounts.db'), ACCOUNTS_MAIL_DIR: join(dir, 'mail') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = await new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve(JSON.parse(d.toString().split('\n')[0])));
    child.once('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  assert.equal(line.msg, 'listening');
  assert.equal(line.host, '127.0.0.1');
  assert.equal(line.signupOpen, false);
  const res = await createClient(`http://127.0.0.1:${line.port}`).call('GET', '/health');
  assert.equal(res.status, 200);
  const code = await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
  assert.equal(code, 0);
});
