// Temp-root integration for the real deploy helper. It rewrites the helper's absolute paths into a
// throwaway root, stubs the privileged commands, and runs base -> env -> env(again) -> bundle.
// This is the closest CI can get to a server without root/containers; it exercises the actual shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skip = process.platform === 'win32' ? 'POSIX shell only' : false;

function stub(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

test('the helper base/env/bundle stages work in a temp root and preserve secrets', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'llmide-helper-'));
  const bin = join(root, 'bin');
  const stage = join(root, 'stage');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stage, { recursive: true });
  // Privileged commands are stubbed; install is a tiny copy/mkdir implementation.
  stub(bin, 'install', `last=""; prev=""; for a in "$@"; do prev="$last"; last="$a"; done
if [ "$1" = "-d" ]; then
  for a in "$@"; do case "$a" in -*) ;; *) mkdir -p "$a";; esac; done
else
  mkdir -p "$(dirname "$last")"; cp "$prev" "$last"
fi`);
  stub(bin, 'id', 'if [ "$1" = "-u" ]; then echo 0; else echo "uid=0(llmide)"; fi');
  for (const n of ['chown', 'useradd', 'systemctl', 'nginx', 'runuser']) {
    stub(bin, n, n === 'runuser' ? 'shift 2; exec "$@"' : 'exit 0');
  }
  // Real chmod/sha256sum/tar/ln/mv/rm remain on PATH after the stubs.
  const helper = readFileSync(join(REPO, 'deploy/hub/llmide-deploy'), 'utf8')
    .replaceAll('/etc/llmide', join(root, 'etc/llmide'))
    .replaceAll('/var/lib/llmide-deploy', join(root, 'var/lib/llmide-deploy'))
    .replaceAll(/\/var\/lib\/llmide(?!-deploy)/g, join(root, 'var/lib/llmide'))
    .replaceAll('/opt/llmide', join(root, 'opt/llmide'))
    .replaceAll('/srv/llmide', join(root, 'srv/llmide'))
    .replaceAll('/var/www/llmide-web', join(root, 'var/www/llmide-web'))
    .replaceAll('/etc/systemd/system', join(root, 'etc/systemd/system'))
    .replaceAll('/etc/nginx/sites-enabled', join(root, 'etc/nginx/sites-enabled'))
    .replaceAll('/etc/logrotate.d', join(root, 'etc/logrotate.d'))
    .replaceAll('/usr/local/sbin', join(root, 'usr/local/sbin'));
  const script = join(root, 'llmide-deploy');
  writeFileSync(script, helper);
  chmodSync(script, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = (stageName, stdin) => execFileSync('/bin/sh', [script, stageName], { env, input: stdin, encoding: stdin instanceof Buffer ? 'buffer' : 'utf8' });

  writeFileSync(join(stage, 'llmide-core.service'), '[Service]\nExecStart=/x\n');
  writeFileSync(join(stage, 'logrotate'), '/x {}\n');
  run('base', `${stage}\n`);
  assert.ok(existsSync(join(root, 'var/lib/llmide-deploy/staging')), 'base creates the root-owned staging directory');
  assert.ok(existsSync(join(root, 'etc/systemd/system/llmide-core.service')));

  const first = 'NODE_ENV=production\nLLMIDE_JWT_SECRET=aaaa\nLLMIDE_VAULT_KEY=bbbb\nLLMIDE_HUB_DOMAIN=hub.example.com\nLLMIDE_HUB_VERSION=1.2.3\n';
  run('env', first);
  const envPath = join(root, 'etc/llmide/core.env');
  assert.ok(readFileSync(envPath, 'utf8').includes('LLMIDE_JWT_SECRET=aaaa'));
  run('env', 'NODE_ENV=production\nLLMIDE_JWT_SECRET=cccc\nLLMIDE_VAULT_KEY=dddd\nLLMIDE_HUB_DOMAIN=hub.example.com\nLLMIDE_HUB_VERSION=1.2.4\n');
  const redeployed = readFileSync(envPath, 'utf8');
  assert.ok(redeployed.includes('LLMIDE_JWT_SECRET=aaaa'), 'a re-deploy keeps the old JWT secret');
  assert.ok(redeployed.includes('LLMIDE_VAULT_KEY=bbbb'), 'a re-deploy keeps the old vault key');
  assert.ok(existsSync(`${envPath}.prev`), 'the previous env is backed up');

  // A real tar layout: core/node/node (the helper must find it under core/).
  const core = join(stage, 'fake/core/node');
  mkdirSync(core, { recursive: true });
  const node = join(core, 'node');
  writeFileSync(node, '#!/bin/sh\necho v22.0.0\n');
  chmodSync(node, 0o755);
  const tar = join(stage, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', join(stage, 'fake'), 'core']);
  const sha = execFileSync('sha256sum', [tar], { encoding: 'utf8' }).split(/\s+/)[0];
  run('upload', Buffer.concat([Buffer.from('bundle.tar.gz\n'), readFileSync(tar)]));
  run('upload', `bundle.sha256\n${sha}  bundle.tar.gz\n`);
  run('bundle');
  assert.ok(existsSync(join(root, 'opt/llmide/current/core/node/node')), 'the release has core/node/node');
  rmSync(root, { recursive: true, force: true });
});
