import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'web/src/host-api/types.generated.ts');

test('the TS output exists and loads under strip-types with the full surface', () => {
  assert.ok(existsSync(OUT), 'run node scripts/generate-host-api.mjs');
  const code = `const m = await import(${JSON.stringify(pathToFileURL(OUT).href)});
    console.log(JSON.stringify({ v: m.HOST_API_VERSION, c: Object.keys(m.HOST_API_COMMANDS).length, e: m.HOST_API_EVENT_NAMES.length,
      caps: m.HOST_API_CAPABILITIES, codes: m.HOST_API_ERROR_CODES.length, send: m.HOST_API_COMMANDS['chat.send'] }));`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), {
    v: 1, c: 17, e: 7, caps: ['host', 'chat', 'approvals', 'tool_approvals', 'read', 'compose'], codes: 11, send: { capability: 'chat', idempotent: false },
  });
});

test('the generated types accept contract payloads and reject unknown fields', (t) => {
  const tsc = join(ROOT, 'desktop/node_modules/.bin/tsc');
  if (!existsSync(tsc)) return t.skip('desktop/node_modules missing (cd desktop && npm ci)');
  const dir = mkdtempSync(join(tmpdir(), 'host-api-ts-'));
  const check = join(dir, 'check.ts');
  writeFileSync(check, `import type { HostApiRequest, HostApiResult, HostApiEventMap } from ${JSON.stringify(OUT)};
const send: HostApiRequest<"chat.send"> = { text: "hi", attachments: [{ name: "a.txt", text: "b" }] };
const hello: HostApiResult<"host.hello"> = { hostName: "h", hostKind: "desktop", apiVersion: 1, apiVersions: [1], capabilities: ["chat"], protocolVersion: 1, requiresAuth: true };
const answers: HostApiRequest<"approvals.answer"> = { requestId: "r", commandId: "c", answers: { "Pick?": "Yes" } };
const done: HostApiEventMap["chat.done"] = { requestId: "c-1", stopReason: "end_turn" };
// @ts-expect-error closed payloads: unknown fields are refused
const bad: HostApiRequest<"chat.cancel"> = { surprise: 1 };
// @ts-expect-error decision is allow_once | deny only
const always: HostApiRequest<"toolApprovals.answer"> = { requestId: "r", commandId: "c", decision: "always" };
void send; void hello; void answers; void done; void bad; void always;
`);
  const r = spawnSync(tsc, ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--allowImportingTsExtensions', check], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
