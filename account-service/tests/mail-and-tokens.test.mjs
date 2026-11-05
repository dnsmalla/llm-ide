import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { createMailer, deliver } from '../src/mailer.mjs';
import { createEmailTokens, EMAIL_TOKEN_TTL_MS } from '../src/email-tokens.mjs';
import { signupMail } from '../src/mail-templates.mjs';
import { loadConfig } from '../src/config.mjs';
import { memoryMailer, waitForMail, linkToken } from './helpers.mjs';

test('file transport appends one JSON line per mail, owner-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'accounts-mail-'));
  const mailer = createMailer({ transport: 'file', dir, from: 'LLM-IDE <no-reply@llm-ide.com>' });
  await mailer.send({ to: 'a@example.com', subject: 's', text: 't' });
  const line = JSON.parse(readFileSync(mailer.file, 'utf8').trim());
  assert.deepEqual(line, { from: 'LLM-IDE <no-reply@llm-ide.com>', to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(statSync(mailer.file).mode & 0o077, 0);
});

test('deliver retries a failing provider and reports a final failure', async () => {
  const flaky = memoryMailer();
  flaky.fail = 2;
  deliver(flaky, { to: 'a@example.com', subject: 's', text: 't' }, { retryMs: 1 });
  await waitForMail(flaky, 1);

  const down = memoryMailer();
  down.fail = 99;
  let failed = false;
  deliver(down, { to: 'a@example.com', subject: 's', text: 't' }, { retryMs: 1, onFail: () => { failed = true; } });
  for (let i = 0; i < 400 && !failed; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(failed, true);
  assert.equal(down.sent.length, 0);
});

test('signup mail carries the token in the fragment of the verify page', () => {
  const config = loadConfig({ ACCOUNTS_ORIGIN: 'http://localhost:3470' });
  const token = 'A'.repeat(43);
  const mail = signupMail(config, 'a@example.com', token);
  assert.match(mail.text, /http:\/\/localhost:3470\/account\/verify#purpose=signup&token=A{43}/);
  assert.equal(linkToken(mail), token);
});

test('email tokens: hash at rest, single use, purpose-bound, 15 minutes, siblings die', () => {
  const db = openDb(':memory:');
  let t = 1_000;
  const tokens = createEmailTokens(db, () => t);

  const a = tokens.issue('signup', 'a@example.com', { displayName: 'Ada' });
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  const stored = db.prepare('SELECT token_hash FROM email_tokens').pluck().get();
  assert.notEqual(stored, a);
  assert.match(stored, /^[0-9a-f]{64}$/);

  assert.equal(tokens.consume('recovery', a), null);
  assert.deepEqual(tokens.consume('signup', a), { email: 'a@example.com', payload: { displayName: 'Ada' } });
  assert.equal(tokens.consume('signup', a), null);

  const old = tokens.issue('signup', 'b@example.com');
  const fresh = tokens.issue('signup', 'b@example.com');
  assert.ok(tokens.consume('signup', fresh));
  assert.equal(tokens.consume('signup', old), null);

  const late = tokens.issue('recovery', 'c@example.com');
  t += EMAIL_TOKEN_TTL_MS;
  assert.equal(tokens.consume('recovery', late), null);

  assert.equal(tokens.consume('signup', 'not-a-token'), null);
  assert.equal(tokens.consume('signup', undefined), null);
  db.close();
});
