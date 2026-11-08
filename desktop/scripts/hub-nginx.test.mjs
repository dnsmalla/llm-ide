import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vhost = readFileSync(join(REPO, 'deploy/hub/llm-ide-hub.nginx.template'), 'utf8');

test('the public hub edge never proxies /admin/', () => {
  const admin = vhost.indexOf('location ^~ /admin/');
  const root = vhost.lastIndexOf('location / {');
  assert.ok(admin > 0, 'an explicit /admin/ block exists');
  assert.ok(admin < root, '/admin/ is matched before the catch-all proxy');
  assert.match(vhost.slice(admin, admin + 80), /return 404/);
});
