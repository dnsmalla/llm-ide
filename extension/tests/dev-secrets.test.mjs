// Dev secrets resolution (core/dev-secrets.mjs). Temp dirs only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDevSecrets } from '../core/dev-secrets.mjs';

let dir; let primary; let legacy;
const good = { jwtSecret: 'j'.repeat(64), vaultKey: 'v'.repeat(64) };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsec-'));
  primary = path.join(dir, 'system', '.dev-secrets.json');
  legacy = path.join(dir, 'repo', 'kb', '.dev-secrets.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the primary file wins when it exists', () => {
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.writeFileSync(primary, JSON.stringify(good));
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64) }));
  const s = loadDevSecrets({ primaryFile: primary, legacyFile: legacy });
  assert.equal(s.vaultKey, good.vaultKey);
  assert.equal(s.generated, false);
});

test('falls back to the legacy file without writing a new key into the primary', () => {
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify(good));
  const s = loadDevSecrets({ primaryFile: primary, legacyFile: legacy });
  assert.equal(s.vaultKey, good.vaultKey);
  assert.equal(s.jwtSecret, good.jwtSecret);
  assert.equal(s.generated, false);
  assert.equal(fs.existsSync(primary), false, 'a key must not be generated while a legacy file exists');
});

test('generates and stores a new key only when no file exists, mode 0600', () => {
  const s = loadDevSecrets({ primaryFile: primary, legacyFile: legacy });
  assert.equal(s.generated, true);
  assert.ok(s.vaultKey.length >= 32 && s.jwtSecret.length >= 32);
  assert.equal(fs.statSync(primary).mode & 0o777, 0o600);
  assert.equal(loadDevSecrets({ primaryFile: primary, legacyFile: legacy }).vaultKey, s.vaultKey);
});

test('an unreadable legacy file is a hard error and no key is generated', () => {
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{ not json');
  assert.throws(() => loadDevSecrets({ primaryFile: primary, legacyFile: legacy }), /refusing to generate a new key/);
  assert.equal(fs.existsSync(primary), false);
});

test('an unreadable primary file is a hard error', () => {
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.writeFileSync(primary, '');
  assert.throws(() => loadDevSecrets({ primaryFile: primary, legacyFile: legacy }), /cannot be read/);
});

test('a file missing a key is a hard error', () => {
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.writeFileSync(primary, JSON.stringify({ jwtSecret: 'j'.repeat(64) }));
  assert.throws(() => loadDevSecrets({ primaryFile: primary, legacyFile: legacy }), /missing jwtSecret or vaultKey/);
});
