// R-034 #1 defence in depth: the hub unit passes the JWT/vault secrets as systemd credentials
// (`LoadCredential=`, readable at $CREDENTIALS_DIRECTORY) instead of EnvironmentFile values, so an
// agent Bash child running as the same uid cannot read them from /proc/<core>/environ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runConfig(extraEnv) {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    LLMIDE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-cred-data-')),
    ...extraEnv,
  };
  for (const k of ['LLMIDE_JWT_SECRET', 'LLMIDE_VAULT_KEY', 'LLMIDE_DB_PATH', 'CREDENTIALS_DIRECTORY']) {
    if (!(k in extraEnv)) delete env[k];
  }
  return execFileSync(process.execPath, ['--input-type=module', '-e',
    "import('./core/config.mjs').then(({config}) => console.log(JSON.stringify({jwt: config.jwtSecret, vault: config.vaultKey})));",
  ], { cwd: EXT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

test('R-034 #1: production reads the JWT/vault secrets from CREDENTIALS_DIRECTORY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-cred-'));
  fs.writeFileSync(path.join(dir, 'jwt-secret'), 'j'.repeat(48) + '\n');
  fs.writeFileSync(path.join(dir, 'vault-key'), 'v'.repeat(48) + '\n');
  const out = runConfig({ CREDENTIALS_DIRECTORY: dir });
  assert.deepEqual(JSON.parse(out), { jwt: 'j'.repeat(48), vault: 'v'.repeat(48) });
});

test('R-034 #1: an explicit environment value still wins over a credential file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-cred-'));
  fs.writeFileSync(path.join(dir, 'jwt-secret'), 'j'.repeat(48));
  fs.writeFileSync(path.join(dir, 'vault-key'), 'v'.repeat(48));
  const out = runConfig({ CREDENTIALS_DIRECTORY: dir, LLMIDE_JWT_SECRET: 'e'.repeat(48) });
  assert.equal(JSON.parse(out).jwt, 'e'.repeat(48));
});

test('R-034 #1: production without either source fails closed', () => {
  assert.throws(() => runConfig({}), /must be set in production/);
});
