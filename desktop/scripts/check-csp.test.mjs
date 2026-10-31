// The release CSP is the webview's main containment: pin its hardening directives.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const conf = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...values] = d.split(/\s+/); return [name, values];
}));

test('release CSP locks base/form/object/frame-ancestors and carries no dev origins or core ports', () => {
  const csp = conf.app.security.csp;
  const d = directives(csp);
  for (const name of ['base-uri', 'form-action', 'object-src', 'frame-ancestors']) assert.deepEqual(d[name], ["'none'"], name);
  assert.deepEqual(d['default-src'], ["'self'"]);
  assert.ok(!/5173/.test(csp), 'dev server origin in the release CSP');
  assert.ok(!/127\.0\.0\.1|localhost:\d/.test(csp), 'the webview never talks to the core directly');
  assert.ok(!csp.includes("'unsafe-eval'") && !/script-src[^;]*unsafe-inline/.test(csp));
});

test('dev origins live only in devCsp, which keeps the same lockdown', () => {
  const dev = conf.app.security.devCsp;
  assert.ok(dev.includes('127.0.0.1:5173'));
  const d = directives(dev);
  for (const name of ['base-uri', 'form-action', 'object-src', 'frame-ancestors']) assert.deepEqual(d[name], ["'none'"], name);
});

test('the JS prototypes are frozen before page scripts run', () => {
  assert.equal(conf.app.security.freezePrototype, true);
});
