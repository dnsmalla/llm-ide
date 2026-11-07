// Boot integration for Team Hub H1.1 (ADR 0021): a real `node server.mjs` defers
// `<data dir>/team.yaml` on a fresh install (no real accounts yet), generates it
// from the first registered accounts on the next boot, applies an edited file
// before serving, audits the change with actor team.yaml, and refuses to start
// when the file is invalid instead of serving stale grants.
//
// Spawns the server on a loopback port, so it needs local listen permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function childEnv(dir, port) {
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port),
    LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DATA_DIR: dir,
    LLMIDE_DB_PATH: path.join(dir, 'data.db'),
    LLMIDE_LOG_FILE: 'none',
    LLMIDE_JWT_SECRET: 'a'.repeat(48),
    LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0',
    LLMIDE_ENGINE_PREWARM: '0',
    LLMIDE_BCRYPT_COST: '10',
  };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_ENV', 'LLMIDE_HUB', 'LLMIDE_ALLOW_REMOTE',
    'LLMIDE_DISABLE_REGISTRATION', 'LLMIDE_FEATURES', 'LLMIDE_SELF_HEAL']) {
    delete env[key];
  }
  return env;
}

async function startCore(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: EXT, env: childEnv(dir, port), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited during boot:\n${output.slice(-2000)}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server did not boot:\n${output.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return {
    child,
    base,
    output: () => output,
    stop: () => new Promise((resolve) => {
      if (child.exitCode != null) { resolve(); return; }
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }),
  };
}

/** Boot once for the invalid-file case and return the exit code plus the log. */
async function bootUntilExit(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: EXT, env: childEnv(dir, port), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let timer;
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 20_000);
    }),
  ]);
  clearTimeout(timer);
  return { code, output };
}

/**
 * Register through the real route. The first ever account on a fresh install becomes the owner; the
 * second is a plain member (registration is open in this test's child env). Returns the created user.
 */
async function register(base, email) {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'CorrectHorseBattery', displayName: 'Contract' }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, `register ${email} answered ${res.status}: ${text}`);
  return JSON.parse(text).user;
}

const grantOf = (dir, userId) => {
  const db = new Database(path.join(dir, 'data.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT team_role, max_mode, usd_cap_month FROM members WHERE user_id = ?').get(userId);
    return row ? { teamRole: row.team_role, maxMode: row.max_mode, usdCapMonth: row.usd_cap_month } : null;
  } finally {
    db.close();
  }
};

test('boot defers, generates, applies and audits team.yaml, then refuses an invalid file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-team-boot-'));
  try {
    // 1. First boot on an empty data dir DEFERS team.yaml: only the synthetic `legacy` user exists, and
    // an empty file would become authoritative and demote the first registered owner at the next boot.
    const first = await startCore(dir);
    const file = path.join(dir, 'team.yaml');
    assert.equal(fs.existsSync(file), false, 'no empty team.yaml on a fresh install');
    assert.match(first.output(), /team_yaml_deferred/);

    // 2. The first registration creates the install's owner while the file is absent; a second account
    // registers as a plain member. Neither request path writes team.yaml.
    const owner = await register(first.base, 'owner@example.com');
    const member = await register(first.base, 'member@example.com');
    await first.stop();
    assert.deepEqual(grantOf(dir, owner.id), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 },
      'the first real account is the owner');
    assert.deepEqual(grantOf(dir, member.id), { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });
    assert.equal(fs.existsSync(file), false, 'a running core never writes team.yaml on a request path');

    // 3. The next boot generates the file from those accounts, with the owner listed.
    const generated = await startCore(dir);
    await generated.stop();
    assert.ok(fs.existsSync(file), `boot generates team.yaml once accounts exist:\n${generated.output().slice(-2000)}`);
    const inherited = fs.readFileSync(file, 'utf8');
    assert.match(inherited, /members:/);
    assert.match(inherited, /\s{2}owner@example\.com:\n\s{4}role: owner\n\s{4}max_mode: execute\n\s{4}usd_cap_month: 0/);
    assert.match(inherited, /\s{2}member@example\.com:\n\s{4}role: member\n/);
    assert.deepEqual(grantOf(dir, owner.id), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
    assert.deepEqual(grantOf(dir, member.id), { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });

    // 4. A second boot with the same file is idempotent: no rewrite, no change, no new generate.
    const again = await startCore(dir);
    await again.stop();
    assert.equal(fs.readFileSync(file, 'utf8'), inherited, 'an existing file is never rewritten');

    // 5. Edit the file as the user would: the next boot applies it before serving.
    fs.writeFileSync(file, [
      'members:',
      '  owner@example.com:',
      '    role: owner',
      '    max_mode: execute',
      '    usd_cap_month: 0',
      '  member@example.com:',
      '    role: viewer',
      '    max_mode: read_only',
      '    usd_cap_month: 9',
    ].join('\n'), 'utf8');

    const applied = await startCore(dir);
    await applied.stop();
    assert.deepEqual(grantOf(dir, owner.id), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
    assert.deepEqual(grantOf(dir, member.id), { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 9 });

    const audit = (() => {
      const db = new Database(path.join(dir, 'data.db'), { readonly: true });
      try {
        return db.prepare(
          "SELECT user_id, user_agent, request_id, outcome, detail FROM audit_log WHERE action = 'team.yaml.apply'",
        ).all();
      } finally { db.close(); }
    })();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, member.id);
    assert.equal(audit[0].user_agent, 'team.yaml');
    assert.equal(audit[0].request_id, 'team.yaml');

    // 6. An invalid file exits instead of serving the previous (wider) grants.
    fs.writeFileSync(file,
      'members:\n  member@example.com:\n    role: root\n    max_mode: execute\n    usd_cap_month: 0\n',
      'utf8');
    const bad = await bootUntilExit(dir);
    assert.equal(bad.code, 1, `invalid team.yaml refuses the boot:\n${bad.output.slice(-2000)}`);
    assert.match(bad.output, /team_yaml_invalid/);
    assert.deepEqual(grantOf(dir, member.id), { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 9 },
      'the last valid grants stay in place; no partial application');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
