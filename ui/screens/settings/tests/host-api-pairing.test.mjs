// Host API pairing card: hidden when the core does not serve the Host API to this UI, the PIN shows as six digits with
// its port, and Revoke goes through a Cancel-first confirmation. Answers are the schema/http/host-api fixtures.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = resolve(HERE, "..");
const REPO = resolve(SETTINGS, "../../..");
const DESKTOP = join(REPO, "desktop");
const req = createRequire(join(DESKTOP, "package.json"));
const { build } = req("esbuild");
const { createElement: h } = req("react");
const { renderToStaticMarkup } = req("react-dom/server");

const reply = (name) => {
  const j = JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/host-api", `${name}.json`), "utf8"));
  return { status: j.status, body: j.response };
};
const fake = (routes) => {
  const calls = [];
  return { calls, async request(method, path) { calls.push(`${method} ${path}`); return routes[`${method} ${path}`] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }; } };
};

let m;
before(async () => {
  const outdir = bundleDir("settings-host-api");
  await build({
    entryPoints: { card: join(SETTINGS, "sections/HostApiPairing.tsx") },
    outdir, bundle: true, splitting: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent",
    loader: { ".css": "text" },
    alias: { "@llmide/ui-kit/styles.css": resolve(SETTINGS, "../../kit/src/styles/kit.css"), "@llmide/ui-kit": resolve(SETTINGS, "../../kit/src/index.ts") },
  });
  m = await import(`${pathToFileURL(join(outdir, "card.js")).href}?t=${Date.now()}`);
});

test("the card hides on HOST_API_DISABLED and on a missing host proof, and shows the list otherwise", async () => {
  assert.equal(await m.loadDevices(fake({ "GET /host-api/devices": reply("get-host-api-devices-404-disabled") })), null);
  assert.equal(await m.loadDevices(fake({ "GET /host-api/devices": reply("get-host-api-devices-403-no-proof") })), null);
  const list = await m.loadDevices(fake({ "GET /host-api/devices": reply("get-host-api-devices-200") }));
  assert.deepEqual(list.map((d) => d.name), ["iPhone"]);
  await assert.rejects(m.loadDevices(fake({})), (e) => e.code === "NOT_FOUND", "any other refusal is an error, not a hidden card");
});

const view = (over) => renderToStaticMarkup(h(m.HostApiPairingView, {
  devices: [], pin: null, now: 0, busy: false, error: null, confirming: null,
  onShowPin() {}, onAskRevoke() {}, onCancelRevoke() {}, onRevoke() {}, ...over,
}));

test("Show pairing PIN displays the six digits, the port and the countdown", async () => {
  const pin = await m.mintPin(fake({ "POST /host-api/pin": reply("post-host-api-pin-200") }));
  assert.match(pin.pin, /^[0-9]{6}$/);
  assert.match(view({}), /Show pairing PIN/);
  const html = view({ pin, now: pin.expiresAt - 125_000 });
  assert.match(html, new RegExp(`>${pin.pin}<`));
  assert.match(html, /127\.0\.0\.1:3016\/host-api\/v1/);
  assert.match(html, /expires in 2:05/);
  assert.doesNotMatch(view({ pin, now: pin.expiresAt }), new RegExp(pin.pin), "an expired PIN is not shown");
  assert.throws(() => m.decodePin({ pin: "12345", expiresAt: 1, port: 3016 }), /BAD_RESPONSE/);
});

test("Revoke asks first (Cancel focused first), then deletes the device", async () => {
  const devices = m.decodeDevices(reply("get-host-api-devices-200").body);
  assert.doesNotMatch(view({ devices }), /alertdialog/);
  const asking = view({ devices, confirming: devices[0].deviceId });
  assert.match(asking, /role="alertdialog"/);
  assert.ok(asking.indexOf(">Cancel<") < asking.lastIndexOf(">Revoke<"));
  const id = devices[0].deviceId;
  const client = fake({ [`DELETE /host-api/devices/${id}`]: reply("delete-host-api-devices--id-200") });
  assert.equal(await m.revokeDevice(client, id), true);
  assert.deepEqual(client.calls, [`DELETE /host-api/devices/${id}`]);
});
