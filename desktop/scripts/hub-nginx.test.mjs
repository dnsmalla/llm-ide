// R-034 #5: the public hub edge must pass exactly the team console's member/invite routes to the core
// (which gates them by JWT + team role) and keep every other /admin path at 404. The desktop proxy
// forwards to this same edge, so this is the only place the rule can live.
//
// The matcher below mirrors nginx's location precedence for the kinds this template uses: an exact
// (`=`) match wins, then the longest plain prefix; `^~` stops regex evaluation; `~` regexes are tried
// in order after the longest prefix. It lets the test assert behaviour for real request paths rather
// than only grepping for block text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vhost = readFileSync(join(REPO, 'deploy/hub/llm-ide-hub.nginx.template'), 'utf8');

function parseLocations(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*location\s+(.+?)\s*\{(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[2];
    const body = [];
    if (rest.includes('}')) {
      body.push(rest.slice(0, rest.indexOf('}')));
    } else {
      if (rest.trim()) body.push(rest);
      for (i += 1; i < lines.length && lines[i].trim() !== '}'; i += 1) body.push(lines[i]);
    }
    const spec = m[1].trim();
    const directive = body.join('\n');
    const exact = /^=\s*(\S+)$/.exec(spec);
    if (exact) { out.push({ kind: 'exact', value: exact[1], directive }); continue; }
    const stop = /^\^~\s*(\S+)$/.exec(spec);
    if (stop) { out.push({ kind: 'stop', value: stop[1], directive }); continue; }
    const regex = /^~\s*(\S+)$/.exec(spec);
    if (regex) { out.push({ kind: 'regex', value: regex[1], directive }); continue; }
    const plain = /^(\S+)$/.exec(spec);
    if (plain) out.push({ kind: 'prefix', value: plain[1], directive });
  }
  return out;
}

const locations = parseLocations(vhost);
function route(rawUrl) {
  const path = String(rawUrl).split('?')[0];
  const exact = locations.find((l) => l.kind === 'exact' && l.value === path);
  if (exact) return exact;
  const prefixes = locations
    .filter((l) => (l.kind === 'prefix' || l.kind === 'stop') && path.startsWith(l.value))
    .sort((a, b) => b.value.length - a.value.length);
  const best = prefixes[0];
  if (best?.kind === 'stop') return best;
  for (const l of locations.filter((x) => x.kind === 'regex')) {
    if (new RegExp(l.value).test(path)) return l;
  }
  return best ?? null;
}
const action = (url) => {
  const loc = route(url);
  if (!loc) return 'none';
  if (/return\s+404/.test(loc.directive)) return '404';
  if (/proxy_pass\s+http:\/\/127\.0\.0\.1:3457/.test(loc.directive)) return 'proxy';
  return 'other';
};

test('the public hub edge passes only /admin/members, /admin/members/* and /admin/invites*', () => {
  for (const url of [
    '/admin/members',
    '/admin/members?project=p-1',
    '/admin/members/',
    '/admin/members/u-1',
    '/admin/invites',
    '/admin/invites?status=open',
    '/admin/invites/',
    '/admin/invites/i-1',
  ]) {
    assert.equal(action(url), 'proxy', `${url} must reach the core (JWT + role gated there)`);
  }
  for (const url of [
    '/admin',
    '/admin/',
    '/admin/backup',
    '/admin/maintenance',
    '/admin/metrics',
    '/admin/users/u-1',
    '/admin/membersX',
    '/admin/invitesX',
    '/metrics',
  ]) {
    assert.equal(action(url), '404', `${url} must stay 404 at the edge`);
  }
});

test('the bare /admin is still refused and /admin/ is matched before the catch-all proxy', () => {
  const bare = vhost.indexOf('location = /admin {');
  const adminPrefix = vhost.indexOf('location /admin/ {');
  const root = vhost.lastIndexOf('location / {');
  assert.ok(bare > 0, 'the bare /admin is refused too');
  assert.ok(adminPrefix > 0, 'an explicit /admin/ block exists');
  assert.ok(bare < root && adminPrefix < root, '/admin is matched before the catch-all proxy');
});

test('the desktop proxy forwards the member/invite methods and paths unchanged to the edge', () => {
  const proxy = readFileSync(join(REPO, 'desktop/src-tauri/src/remote_proxy.rs'), 'utf8');
  assert.match(proxy, /let url = format!\("\{hub\}\{\}", req\.path\);/,
    'the proxy hands the path to the hub unchanged (no local /admin filtering)');
  assert.match(proxy, /GET, POST, PUT, PATCH, DELETE, OPTIONS/, 'PATCH/DELETE reach the edge');
  assert.match(proxy, /"authorization"/, 'the bearer token is forwarded');
});
