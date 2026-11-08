// Temp-root integration for the real deploy helper. It rewrites the helper's absolute paths into a
// throwaway root, stubs the privileged commands, and runs the actual shell. This is the closest CI
// can get to a server without root/containers; the container run in R-027 exercised systemd/nginx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HUB = join(REPO, 'deploy/hub');
const skip = process.platform === 'win32' ? 'POSIX shell only' : false;
const helperSource = readFileSync(join(HUB, 'llmide-deploy'), 'utf8');
const unitSource = readFileSync(join(HUB, 'llmide-core.service'), 'utf8');
const backupUnitSource = readFileSync(join(HUB, 'llmide-backup.service'), 'utf8');
const logrotateSource = readFileSync(join(HUB, 'logrotate'), 'utf8');

function has(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
}

function stub(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

// The helper installs files and directories; this stub parses the option/value pairs instead of
// treating "root", "0700", ... as paths (a bug that used to litter the cwd with empty directories).
const INSTALL_STUB = `is_dir=0; dirs=""; src=""; dst=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) is_dir=1; shift;;
    -m|-o|-g) shift 2;;
    -*) shift;;
    *) if [ "$is_dir" = 1 ]; then dirs="$dirs $1"; else src="$dst"; dst="$1"; fi; shift;;
  esac
done
if [ "$is_dir" = 1 ]; then
  for d in $dirs; do mkdir -p "$d"; done
else
  mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"
fi`;

function harness({ nginxFails = false, systemctlFailsEnable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'llmide-helper-'));
  const bin = join(root, 'bin');
  const stage = join(root, 'stage');
  const systemctlLog = join(root, 'systemctl.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stage, { recursive: true });

  stub(bin, 'install', INSTALL_STUB);
  stub(bin, 'id', 'if [ "$1" = "-u" ]; then echo 0; else echo "uid=0(llmide)"; fi');
  for (const n of ['chown', 'useradd']) stub(bin, n, 'exit 0');
  stub(bin, 'runuser', 'shift 2; [ "$1" = "--" ] && shift; exec "$@"');
  stub(bin, 'systemctl', `if [ "$1" = "enable" ] && [ "${systemctlFailsEnable ? '1' : '0'}" = "1" ]; then exit 1; fi
printf '%s\\n' "$*" >> '${systemctlLog}'`);
  stub(bin, 'nginx', nginxFails ? 'exit 1' : 'exit 0');

  // Real chmod/sha256sum/tar/ln/mv/rm remain on PATH after the stubs.
  const helper = helperSource
    .replaceAll('/etc/llmide', join(root, 'etc/llmide'))
    .replaceAll('/var/lib/llmide-deploy', join(root, 'var/lib/llmide-deploy'))
    .replaceAll(/\/var\/lib\/llmide(?!-deploy)/g, join(root, 'var/lib/llmide'))
    .replaceAll('/opt/llmide', join(root, 'opt/llmide'))
    .replaceAll('/srv/llmide', join(root, 'srv/llmide'))
    .replaceAll('/var/www/llmide-web', join(root, 'var/www/llmide-web'))
    .replaceAll('/etc/systemd/system', join(root, 'etc/systemd/system'))
    .replaceAll('/etc/nginx/sites-enabled', join(root, 'etc/nginx/sites-enabled'))
    .replaceAll('/etc/logrotate.d', join(root, 'etc/logrotate.d'))
    .replaceAll('/etc/sudoers.d', join(root, 'etc/sudoers.d'))
    .replaceAll('/etc/letsencrypt', join(root, 'etc/letsencrypt'))
    .replaceAll('/usr/local/sbin', join(root, 'usr/local/sbin'));
  const script = join(root, 'llmide-deploy');
  writeFileSync(script, helper);
  chmodSync(script, 0o755);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = (stageName, input) => execFileSync('/bin/sh', [script, stageName], {
    env, input, encoding: input instanceof Buffer ? 'buffer' : 'utf8',
  });
  const runFail = (stageName, input) => spawnSync('/bin/sh', [script, stageName], { env, input, encoding: 'utf8' });
  return {
    root, stage, systemctlLog, run, runFail,
    unit: join(root, 'etc/systemd/system/llmide-core.service'),
    site: join(root, 'etc/nginx/sites-enabled/llm-ide-hub'),
    helper: join(root, 'usr/local/sbin/llmide-deploy'),
    sudoers: join(root, 'etc/sudoers.d/llmide-deploy'),
    envPath: join(root, 'etc/llmide/core.env'),
    releaseNode: join(root, 'opt/llmide/current/core/node/node'),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function fakeBundle(h) {
  const core = join(h.stage, 'fake/core/node');
  mkdirSync(core, { recursive: true });
  const node = join(core, 'node');
  writeFileSync(node, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.0.0; else echo fake; fi\n');
  chmodSync(node, 0o755);
  const web = join(h.stage, 'fake/core/root/web');
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html>hub');
  writeFileSync(join(h.stage, 'fake/VERSION'), '1.2.3\n');
  const tar = join(h.stage, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', join(h.stage, 'fake'), 'core', 'VERSION']);
  const sha = execFileSync('sha256sum', [tar], { encoding: 'utf8' }).split(/\s+/)[0];
  h.run('upload', Buffer.concat([Buffer.from('bundle.tar.gz\n'), readFileSync(tar)]));
  h.run('upload', `bundle.sha256\n${sha}  bundle.tar.gz\n`);
}

const ENV1 = 'NODE_ENV=production\nLLMIDE_JWT_SECRET=aaaa\nLLMIDE_VAULT_KEY=bbbb\nLLMIDE_HUB_DOMAIN=hub.example.com\nLLMIDE_HUB_VERSION=1.2.3\n';
const ENV2 = 'NODE_ENV=production\nLLMIDE_JWT_SECRET=cccc\nLLMIDE_VAULT_KEY=dddd\nLLMIDE_HUB_DOMAIN=hub.example.com\nLLMIDE_HUB_VERSION=1.2.4\n';

test('the helper embeds the same unit, backup unit and logrotate as deploy/hub', () => {
  const unit = helperSource.match(/cat > "\$UNIT" <<'LLMIDE_UNIT'\n([\s\S]*?)\nLLMIDE_UNIT\n/)[1] + '\n';
  const backup = helperSource.match(/cat > "\$BACKUP_UNIT" <<'LLMIDE_BACKUP'\n([\s\S]*?)\nLLMIDE_BACKUP\n/)[1] + '\n';
  const logrotate = helperSource.match(/cat > \/etc\/logrotate.d\/llmide <<'LLMIDE_LOG'\n([\s\S]*?)\nLLMIDE_LOG\n/)[1] + '\n';
  assert.equal(unit, unitSource, 'the helper must install the hardened unit, not a stale copy');
  assert.equal(backup, backupUnitSource);
  assert.equal(logrotate, logrotateSource);
  assert.match(unit, /^\[Install\]\nWantedBy=multi-user\.target$/m, 'the unit must be enable-able');
});

test('base/env/bundle/start work in a temp root and preserve secrets', { skip }, () => {
  const h = harness();
  try {
    h.run('base', `${h.stage}\n`);
    assert.ok(existsSync(join(h.root, 'var/lib/llmide-deploy/staging')), 'base creates the root-owned staging directory');
    assert.ok(existsSync(h.unit));
    const emitted = readFileSync(h.unit, 'utf8');
    assert.match(emitted, /UMask=0077/);
    assert.match(emitted, /\[Install\]\nWantedBy=multi-user\.target/);

    h.run('env', ENV1);
    assert.ok(readFileSync(h.envPath, 'utf8').includes('LLMIDE_JWT_SECRET=aaaa'));
    assert.equal(statSync(h.envPath).mode & 0o777, 0o600);
    h.run('env', ENV2);
    const redeployed = readFileSync(h.envPath, 'utf8');
    assert.ok(redeployed.includes('LLMIDE_JWT_SECRET=aaaa'), 'a re-deploy keeps the old JWT secret');
    assert.ok(redeployed.includes('LLMIDE_VAULT_KEY=bbbb'), 'a re-deploy keeps the old vault key');
    assert.ok(existsSync(`${h.envPath}.prev`), 'the previous env is backed up');

    fakeBundle(h);
    h.run('bundle');
    assert.ok(existsSync(h.releaseNode), 'the release has core/node/node');
    assert.notEqual(statSync(h.releaseNode).mode & 0o005, 0, 'node must be executable by the service user');
    assert.ok(existsSync(join(h.root, 'var/www/llmide-web/index.html')), 'the PWA is copied after the release switch');
    assert.match(h.run('check'), /helper=1/, 'check reports the helper version');
    h.run('upload', 'VERSION\n1.2.3\n');
    assert.notEqual(h.runFail('update').status, 0, 'a same-version update is refused');

    h.run('start');
    const calls = readFileSync(h.systemctlLog, 'utf8');
    assert.match(calls, /^enable llmide-core$/m);
    assert.match(calls, /^restart llmide-core$/m);
  } finally { h.cleanup(); }
});

test('env rejects CR and a final line without a newline, and accepts a valid one', { skip }, () => {
  const h = harness();
  try {
    h.run('base', `${h.stage}\n`);
    // GNU grep used to read '\r' as a literal 'r', rejecting NODE_ENV=production on Ubuntu.
    h.run('env', ENV1);
    assert.ok(existsSync(h.envPath));

    const cr = h.runFail('env', 'NODE_ENV=production\r\nLLMIDE_JWT_SECRET=aaaa\n');
    assert.notEqual(cr.status, 0, 'a real CR must be rejected');

    // The allowlist loop used to skip the last line when it had no trailing newline.
    const bypass = h.runFail('env', 'NODE_ENV=production\nLLMIDE_JWT_SECRET=aaaa\nLLMIDE_HUB_DOMAIN=hub.example.com\nLLMIDE_HUB_VERSION=1.2.3\nEVIL=1');
    assert.notEqual(bypass.status, 0, 'an unknown final key without a newline must be rejected');

    const noNewline = 'NODE_ENV=production\nLLMIDE_JWT_SECRET=aaaa\nLLMIDE_HUB_DOMAIN=hub.example.com\nLLMIDE_HUB_VERSION=1.2.3';
    h.run('env', noNewline);
    assert.ok(readFileSync(h.envPath, 'utf8').includes('LLMIDE_HUB_VERSION=1.2.3'));
  } finally { h.cleanup(); }
});

test('uninstall removes the helper and sudoers even when core.env is missing', { skip }, () => {
  const h = harness();
  try {
    h.run('base', `${h.stage}\n`);
    mkdirSync(dirname(h.helper), { recursive: true });
    writeFileSync(h.helper, '#!/bin/sh\nexit 0\n');
    mkdirSync(dirname(h.sudoers), { recursive: true });
    writeFileSync(h.sudoers, 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/llmide-deploy check\n');
    assert.ok(!existsSync(h.envPath));

    h.run('uninstall');
    assert.ok(!existsSync(h.helper), 'the root helper must be removed on a partially-installed host');
    assert.ok(!existsSync(h.sudoers), 'the NOPASSWD drop-in must be removed');
    assert.ok(!existsSync(h.unit));
  } finally { h.cleanup(); }
});

test('a rejected first vhost is removed so nginx -t stays healthy', { skip: skip || (!has('openssl') || !has('basenc')) ? 'needs openssl and basenc' : false }, () => {
  const h = harness({ nginxFails: true });
  try {
    h.run('base', `${h.stage}\n`);
    h.run('env', 'NODE_ENV=production\nLLMIDE_HUB_DOMAIN=hub.example.test\nLLMIDE_HUB_VERSION=1.2.3\n');
    const live = join(h.root, 'etc/letsencrypt/live/hub.example.test');
    mkdirSync(live, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=hub.example.test', '-keyout', join(live, 'privkey.pem'), '-out', join(live, 'fullchain.pem')], { stdio: 'ignore' });
    h.run('upload', 'llm-ide-hub.nginx\nserver { this_is_not_a_directive; }\n');
    const result = h.runFail('nginx');
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(h.site), 'the rejected vhost must not be left in sites-enabled');
  } finally { h.cleanup(); }
});

test('start fails when systemctl cannot enable the unit', { skip }, () => {
  const h = harness({ systemctlFailsEnable: true });
  try {
    h.run('base', `${h.stage}\n`);
    h.run('env', ENV1);
    fakeBundle(h);
    h.run('bundle');
    const result = h.runFail('start');
    assert.notEqual(result.status, 0, 'a failed enable must not be reported as a started hub');
  } finally { h.cleanup(); }
});
