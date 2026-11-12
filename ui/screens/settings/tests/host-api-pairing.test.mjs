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
let ctx;
before(async () => {
  const outdir = bundleDir("settings-host-api");
  await build({
    entryPoints: { card: join(SETTINGS, "sections/HostApiPairing.tsx"), context: join(SETTINGS, "context.tsx") },
    outdir, bundle: true, splitting: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent",
    loader: { ".css": "text" },
    alias: { "@llmide/ui-kit/styles.css": resolve(SETTINGS, "../../kit/src/styles/kit.css"), "@llmide/ui-kit": resolve(SETTINGS, "../../kit/src/index.ts") },
  });
  m = await import(`${pathToFileURL(join(outdir, "card.js")).href}?t=${Date.now()}`);
  ctx = await import(`${pathToFileURL(join(outdir, "context.js")).href}?t=${Date.now()}`);
});

test("the card hides on HOST_API_DISABLED and on a missing host proof, and shows the list otherwise", async () => {
  assert.equal(await m.loadDevices(fake({ "GET /host-api/devices": reply("get-host-api-devices-404-disabled") })), null);
  const noProof = fake({ "GET /host-api/devices": reply("get-host-api-devices-403-no-proof") });
  assert.equal(await m.loadDevices(noProof, { sleep: async () => {} }), null);
  assert.equal(noProof.calls.length, m.PROOF_RETRY_MS.length + 1, "retried while the proof may still arrive");
  const disabled = fake({ "GET /host-api/devices": reply("get-host-api-devices-404-disabled") });
  await m.loadDevices(disabled, { sleep: async () => {} });
  assert.equal(disabled.calls.length, 1, "a disabled core is not retried");
  const list = await m.loadDevices(fake({ "GET /host-api/devices": reply("get-host-api-devices-200") }));
  assert.deepEqual(list.map((d) => d.name), ["iPhone"]);
  await assert.rejects(m.loadDevices(fake({})), (e) => e.code === "NOT_FOUND", "any other refusal is an error, not a hidden card");
});

test("a proof that arrives after the first probe still shows the card", async () => {
  let n = 0;
  const slept = [];
  const client = { calls: [], async request() { n++; return n < 3 ? reply("get-host-api-devices-403-no-proof") : reply("get-host-api-devices-200"); } };
  const list = await m.loadDevices(client, { sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(list.map((d) => d.name), ["iPhone"]);
  assert.deepEqual(slept, m.PROOF_RETRY_MS.slice(0, 2));
  n = 0;
  assert.equal(await m.loadDevices(client, { sleep: async () => {}, alive: () => false }), null, "an unmounted card stops probing");
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

test("a TLS PIN shows the certificate fingerprint; a dev PIN shows none", async () => {
  const tls = await m.mintPin(fake({ "POST /host-api/pin": reply("post-host-api-pin-200-tls") }));
  assert.match(tls.fingerprint, /^sha256:/);
  const html = view({ pin: tls, now: tls.expiresAt - 1000 });
  assert.ok(html.includes(`Fingerprint: ${tls.fingerprint}`));
  assert.match(html, /wss:\/\//);
  const dev = await m.mintPin(fake({ "POST /host-api/pin": reply("post-host-api-pin-200") }));
  assert.equal(dev.fingerprint, null);
  assert.doesNotMatch(view({ pin: dev, now: dev.expiresAt - 1000 }), /Fingerprint/);
  assert.throws(() => m.decodePin({ pin: "123456", expiresAt: 1, port: 3016, fingerprint: "md5:x" }), /BAD_RESPONSE/);
});

test("a TLS PIN with an address shows the llmide://pair QR, its payload and alt text; a dev PIN or no address shows none", async () => {
  const tls = await m.mintPin(fake({ "POST /host-api/pin": reply("post-host-api-pin-200-tls") }));
  assert.deepEqual(tls.addresses, ["100.101.102.103", "192.168.1.20"]);
  const payload = `llmide://pair?ip=100.101.102.103&ip=192.168.1.20&pin=${tls.pin}&h1port=3016&h1fp=${tls.fingerprint}&api=1`;
  assert.equal(m.pairingPayload(tls), payload, "every address in the core's order, Tailscale first; no v2 port (the phone then dials only v1)");
  // An older phone reads only the first ip: still the core's best address.
  assert.equal(new URL(payload).searchParams.get("ip"), "100.101.102.103");
  assert.deepEqual(new URL(payload).searchParams.getAll("ip"), tls.addresses);
  const html = view({ pin: tls, now: tls.expiresAt - 1000 });
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Pairing QR code for this computer"/);
  assert.match(html, /<path d="M\d/, "dark modules drawn");
  assert.ok(html.includes(payload.replaceAll("&", "&amp;")), "payload shown as copyable text");
  const dev = await m.mintPin(fake({ "POST /host-api/pin": reply("post-host-api-pin-200") }));
  assert.equal(m.pairingPayload(dev), null);
  assert.doesNotMatch(view({ pin: dev, now: dev.expiresAt - 1000 }), /<svg|llmide:\/\/pair/);
  const noAddr = { ...tls, addresses: [] };
  assert.equal(m.pairingPayload(noAddr), null);
  assert.doesNotMatch(view({ pin: noAddr, now: tls.expiresAt - 1000 }), /<svg/);
  assert.deepEqual(m.decodePin({ pin: "123456", expiresAt: 1, port: 3016, fingerprint: null }).addresses, [], "an older core without addresses");
  assert.throws(() => m.decodePin({ pin: "123456", expiresAt: 1, port: 3016, fingerprint: null, addresses: ["evil.example/x"] }), /BAD_RESPONSE/);
});

test("the QR carries at most four addresses, first one first, and every address is validated", () => {
  const fp = `sha256:${"A".repeat(43)}`;
  const six = ["100.64.0.1", "192.168.1.20", "10.0.0.5", "172.17.0.1", "172.18.0.1", "192.168.64.1"];
  const pin = m.decodePin({ pin: "123456", expiresAt: 1, port: 3016, fingerprint: fp, addresses: six });
  const payload = m.pairingPayload(pin);
  assert.equal(m.QR_MAX_ADDRESSES, 4);
  assert.deepEqual(new URL(payload).searchParams.getAll("ip"), six.slice(0, 4), "core order kept, the rest dropped");
  assert.ok(payload.startsWith("llmide://pair?ip=100.64.0.1&ip=192.168.1.20&ip=10.0.0.5&ip=172.17.0.1&pin=123456&"));
  // A bad address anywhere in the list (not only the first) rejects the whole answer, so nothing unescaped reaches the QR.
  for (const bad of ["1.2.3.4&pin=000000", "256.1.1.1", "::1", ""]) {
    assert.throws(() => m.decodePin({ pin: "123456", expiresAt: 1, port: 3016, fingerprint: fp, addresses: ["100.64.0.1", bad] }), /BAD_RESPONSE/);
  }
  // Four of the longest IPv4s still render as a QR at level M.
  const longest = m.decodePin({ pin: "123456", expiresAt: 1, port: 65535, fingerprint: fp, addresses: Array(4).fill("255.255.255.255") });
  const html = renderToStaticMarkup(h(m.PairingQr, { payload: m.pairingPayload(longest) }));
  assert.match(html, /<path d="M\d/);
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

test("the five capability switches render with the next-core-start notice", () => {
  const off = { hostApiTls: false, hostApiRead: false, hostApiCompose: false, hostApiPush: false, hostApiToolApprovals: false };
  const html = renderToStaticMarkup(h(m.HostApiSettingsView, { prefs: off, onSave() {} }));
  assert.match(html, /role="switch"/);
  for (const l of ["Serve the pairing listener (TLS)", "Let paired devices read chats, history and usage",
    "Let paired devices compose chats (modes, models, new chat)", "Send push notifications to paired devices", "Let paired devices answer tool approvals"]) {
    assert.match(html, new RegExp(l.replace(/[()]/g, "\\$&")));
  }
  assert.match(html, /Applies on the next core start\./);
});

test("when the PIN route answers 404 the card shows the pairing hint instead of nothing", async () => {
  // The 404 is what makes the device probe return null; the card must then explain how to turn the listener on.
  assert.equal(await m.loadDevices(fake({ "GET /host-api/devices": reply("get-host-api-devices-404-disabled") })), null);
  const host = {
    getExtraPrefs: async () => ({ compress: false, learn: false, terminal: true, continueSummary: false,
      hostApiTls: false, hostApiRead: false, hostApiCompose: false, hostApiPush: false, hostApiToolApprovals: false }),
    setExtraPrefs: async () => {},
  };
  const client = fake({ "GET /host-api/devices": reply("get-host-api-devices-404-disabled") });
  const html = renderToStaticMarkup(h(ctx.SettingsEnvProvider, { env: { client, host } }, h(m.default)));
  assert.match(html, /The pairing listener is off\./);
  assert.match(html, /Serve the pairing listener \(TLS\)/);
  assert.match(html, /restart the core/);
  assert.doesNotMatch(html, /Show pairing PIN/);
});

test("the revoke confirmation lists offline-sync devices (pre-checked one ticked), or says they could not be checked; the card explains the two lists", () => {
  const devices = m.decodeDevices(reply("get-host-api-devices-200").body);
  const id = devices[0].deviceId;
  const also = { unavailable: false, candidates: [{ deviceId: "s1", label: "iPhone · iPhone app", checked: true }, { deviceId: "s2", label: "Mac browser · browser", checked: false }] };
  const html = view({ devices, confirming: id, also, alsoChecked: ["s1"] });
  assert.match(html, /Also remove from offline sync/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  assert.match(view({ devices, confirming: id, also: { unavailable: true, candidates: [] } }), /Offline sync could not be checked/);
  assert.match(view({ devices }), /separate lists/);
});
