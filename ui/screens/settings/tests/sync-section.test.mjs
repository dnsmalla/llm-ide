// Sync card model: strict decoding of /kb/sync/status, the calls the card makes, and the MEGA error texts. The card
// hides on HOST_PROOF_REQUIRED.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = resolve(HERE, "..");
const req = createRequire(join(resolve(SETTINGS, "../../.."), "desktop", "package.json"));
const { build } = req("esbuild");
let m;
before(async () => {
  const out = join(bundleDir("sync-section"), "sync-model.mjs");
  await build({ entryPoints: [join(SETTINGS, "sync-model.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  m = await import(pathToFileURL(out).href);
});
const fake = (routes) => { const calls = []; return { calls, async request(method, path, body) { calls.push(`${method} ${path} ${body ? JSON.stringify(body) : ""}`.trim()); return routes[`${method} ${path}`] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }; } }; };
const STATUS = { configured: true, enabled: false, storeKind: "mega", store: { folder: "llmide-sync", account: "l***@example.com" },
  syncId: "B".repeat(22), epoch: 1, signingFingerprint: "C".repeat(43), devices: [], lastPublishAt: null, lastError: null };

test("decodeSyncStatus accepts the route shape, rejects junk, and never keeps a password", () => {
  assert.equal(m.decodeSyncStatus(STATUS).store.folder, "llmide-sync");
  assert.throws(() => m.decodeSyncStatus({ ...STATUS, enabled: "no" }));
  const leaked = m.decodeSyncStatus({ ...STATUS, store: { ...STATUS.store, password: "secret" } });
  assert.deepEqual(leaked.store, { folder: "llmide-sync", account: "l***@example.com" });
});

test("calls go to the sync routes with the typed body", async () => {
  const c = fake({ "POST /kb/sync/mega": { status: 200, body: STATUS }, "POST /kb/sync/enabled": { status: 200, body: { ...STATUS, enabled: true } }, "GET /kb/sync/status": { status: 403, body: { error: { code: "HOST_PROOF_REQUIRED", message: "x" } } } });
  await m.saveMega(c, { email: "llmide-sync@example.com", password: "pw", folder: "llmide-sync" });
  assert.equal((await m.setSyncEnabled(c, true)).enabled, true);
  assert.equal(await m.loadSyncStatus(c), null, "hidden without the host proof");
  assert.ok(c.calls[0].startsWith("POST /kb/sync/mega"));
});

test("MEGA error codes read as guidance", () => {
  assert.match(m.syncErrorText("SYNC_MFA_REQUIRED"), /two-factor/);
  assert.match(m.syncErrorText("SYNC_AUTH_FAILED"), /email or password/);
  assert.equal(m.syncErrorText("SOMETHING_ELSE"), null);
});

test('enrollment decoders are strict and the calls hit the device routes', async () => {
  assert.deepEqual(m.decodeEnrollStart({ qr: "llmide://pair?sv=1", expiresAt: 5, tier: "ios" }), { qr: "llmide://pair?sv=1", expiresAt: 5, tier: "ios" });
  assert.throws(() => m.decodeEnrollStart({ qr: "x", expiresAt: 5, tier: "android" }));
  assert.throws(() => m.decodeEnrollStart({ qr: "javascript:alert(1)", expiresAt: 5, tier: "web" }), "only llmide:// or http(s) links render as a QR");
  assert.equal(m.decodeEnrollPoll({ phase: "confirm", sas: "012345", name: "P", code: null }).sas, "012345");
  assert.throws(() => m.decodeEnrollPoll({ phase: "confirm", sas: "12a", name: null, code: null }));
  const s = m.decodeSyncStatus({ ...STATUS, rotationPending: true, devices: [{ deviceId: "d", name: "n", tier: "web", addedAt: 1, folderHint: "Ab3xQz" }] });
  assert.equal(s.devices[0].folderHint, "Ab3xQz"); assert.equal(s.rotationPending, true);
  assert.equal(m.decodeSyncStatus(STATUS).rotationPending, false, "an older core decodes");
  const c = fake({ "POST /kb/sync/devices/enroll": { status: 200, body: { qr: "llmide://pair?sv=1", expiresAt: 1, tier: "ios" } },
    "DELETE /kb/sync/devices/d1": { status: 200, body: STATUS }, "POST /kb/sync/rotate": { status: 200, body: STATUS } });
  await m.startEnroll(c, "ios"); await m.revokeSyncDevice(c, "d1"); await m.rotateSyncKeys(c);
  assert.deepEqual(c.calls, ['POST /kb/sync/devices/enroll {"tier":"ios"}', "DELETE /kb/sync/devices/d1", "POST /kb/sync/rotate {}"]);
  assert.match(m.enrollFailureText("contested"), /Two devices/);
  assert.match(m.enrollFailureText("claim_invalid"), /could not be verified/);
});
