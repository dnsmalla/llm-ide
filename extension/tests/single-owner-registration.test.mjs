// Single-owner registration (LLMIDE_REGISTRATION_SINGLE_OWNER=1, a server core): the first account is
// the owner, a later no-invite sign-up is refused, an invite still works, and the reported "open" value
// flips once the owner exists. Config is frozen at import, so the env is set before the modules load.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_REGISTRATION_SINGLE_OWNER = '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-single-owner-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'data.db');

const { config } = await import('../core/config.mjs');
const { registerUser, selfRegistrationOpen } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { createInvite, getMember } = await import('../kb/members.mjs');

after(() => {
  try { closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const PASSWORD = 'CorrectHorseBattery';
const reg = (email, extra = {}) => registerUser(getDb(), { email, password: PASSWORD, displayName: 'x', ...extra });

test('the flag is read as a boolean and is on', () => {
  assert.equal(config.registrationSingleOwner, true);
  assert.equal(config.registrationOpen, true, 'the test env leaves registration open');
});

test('with no owner yet, the first registration succeeds and becomes the owner', () => {
  assert.equal(selfRegistrationOpen(getDb()), true);
  const owner = reg('owner@example.com');
  assert.equal(getMember(getDb(), owner.id).teamRole, 'owner');
});

test('once an owner exists, a no-invite registration is refused with the closed-registration error', () => {
  assert.throws(() => reg('second@example.com'), /Registration is disabled/);
});

test('the reported open value flips to closed after the first owner', () => {
  assert.equal(selfRegistrationOpen(getDb()), false);
});

test('an invite still lets a registration through once an owner exists', () => {
  const owner = getDb().prepare("SELECT id FROM users WHERE email = 'owner@example.com'").get();
  const { token } = createInvite(getDb(), owner.id, { teamRole: 'member', maxMode: 'read_only', usdCapMonth: 20 });
  const invited = reg('invited@example.com', { invite: token });
  assert.equal(getMember(getDb(), invited.id).teamRole, 'member');
});

test('the well-known answer reports closed once the owner exists (what the sign-in screen reads)', async () => {
  const { handleAuth } = await import('../server/auth-routes.mjs');
  const wellKnown = async () => {
    const req = { url: '/auth/well-known', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const res = {
      headersSent: false,
      writeHead(status) { this.status = status; },
      setHeader() {},
      end(text) { this.body = JSON.parse(text); },
    };
    await handleAuth(req, res, { db: getDb(), logger: null, requestId: 'test' });
    return res.body;
  };
  assert.equal((await wellKnown()).registrationOpen, false);
});
