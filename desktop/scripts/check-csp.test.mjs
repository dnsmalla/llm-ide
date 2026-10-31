// The release CSP is the webview's main containment: pin its hardening directives.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const conf = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const pin = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'resources', 'mermaid.pin.json'), 'utf8'));
// The sandboxed diagram frame is a srcdoc frame, which inherits this CSP: the ONLY inline scripts it may run are the
// pinned mermaid runtime and the fixed boot script, admitted by hash.
const { BOOT_JS } = await import('../../ui/screens/docgen/mermaid/frame.ts');
const BOOT_HASH = `'sha256-${createHash('sha256').update(BOOT_JS).digest('base64')}'`;
const RUNTIME_HASH = `'sha256-${pin.sha256_base64}'`;
const PINNED_SCRIPT_SRC = ["'self'", "'wasm-unsafe-eval'", RUNTIME_HASH, BOOT_HASH];
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...values] = d.split(/\s+/); return [name, values];
}));

test('release CSP locks base/form/object/frame-ancestors and carries no dev origins or core ports', () => {
  const csp = conf.app.security.csp;
  const d = directives(csp);
  for (const name of ['base-uri', 'form-action', 'object-src', 'frame-ancestors']) assert.deepEqual(d[name], ["'none'"], name);
  assert.deepEqual(d['default-src'], ["'self'"]);
  assert.ok(!/5173/.test(csp), 'dev server origin in the release CSP');
  // The webview talks to the core only on the ports the host may spawn it on (SPAWN_PORTS), exact origins, no wildcard.
  const rust = readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'src', 'core_host.rs'), 'utf8');
  const ports = rust.match(/const SPAWN_PORTS: \[u16; \d+\] = \[([\d,\s]+)\]/)[1].split(',').map((p) => p.trim()).filter(Boolean);
  assert.deepEqual(d['connect-src'], ["'self'", 'ipc:', 'http://ipc.localhost', ...ports.map((p) => `http://127.0.0.1:${p}`)]);
  assert.ok(!/\*|localhost:\d|3456/.test(csp), 'no wildcard, no named-host port, not the adoptable 3456');
  assert.ok(!csp.includes("'unsafe-eval'") && !/script-src[^;]*unsafe-inline/.test(csp));
  // WebAssembly (the Code Graph layout kernel) compiles under 'wasm-unsafe-eval' ONLY.
  assert.deepEqual(d['script-src'], PINNED_SCRIPT_SRC);
  assert.deepEqual(d['frame-src'], ['about:'], 'only about:srcdoc frames (the sandboxed diagram renderer), never a network origin');
  // Workers are same-origin files (vite emits graph.worker-*.js); blob: stays only for Monaco's workers.
  assert.deepEqual(d['worker-src'], ["'self'", 'blob:']);
});

test('script-src carries no eval, inline or wildcard source in either CSP', () => {
  for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
    const script = directives(csp)['script-src'];
    assert.ok(script, 'script-src is pinned explicitly');
    assert.ok(!script.includes("'unsafe-eval'") && !script.includes("'unsafe-inline'") && !script.includes('data:'), script.join(' '));
    assert.ok(!script.some((v) => v === '*' || v.includes('*') || /^https?:/.test(v)), `no wildcard or remote script origin: ${script.join(' ')}`);
    assert.ok(script.includes("'wasm-unsafe-eval'"));
  }
});

test('dev origins live only in devCsp, which keeps the same lockdown', () => {
  const dev = conf.app.security.devCsp;
  assert.ok(dev.includes('127.0.0.1:5173'));
  const d = directives(dev);
  for (const name of ['base-uri', 'form-action', 'object-src', 'frame-ancestors']) assert.deepEqual(d[name], ["'none'"], name);
  assert.deepEqual(d['script-src'], PINNED_SCRIPT_SRC);
  assert.deepEqual(d['frame-src'], ['about:']);
});

test('the mermaid pin is internally consistent and matches the Mac app pin', () => {
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(pin.sha256, 'hex').toString('base64'), pin.sha256_base64);
  assert.equal(pin.url, `https://cdn.jsdelivr.net/npm/mermaid@${pin.version}/dist/mermaid.min.js`);
  assert.equal(pin.license, 'MIT');
  const mac = readFileSync(join(import.meta.dirname, '..', '..', 'mac', 'Sources', 'LlmIdeMac', 'Core', 'Editor', 'Mermaid.swift'), 'utf8');
  assert.ok(mac.includes(`"${pin.version}"`) && mac.includes(`"${pin.sha256}"`) && mac.includes(String(pin.bytes).replace(/(\d)(?=(\d{3})+$)/g, '$1_')), 'same release, hash and size as the Mac pin');
});

test('the JS prototypes are frozen before page scripts run', () => {
  assert.equal(conf.app.security.freezePrototype, true);
});
