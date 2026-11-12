// Linked revoke between Live Chat pairing and offline sync: the matching rule and the outcome summary.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const SETTINGS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(join(SETTINGS, "../../../desktop/package.json"))("esbuild");
let m;
before(async () => {
  const out = join(bundleDir("settings-device-link"), "m.mjs");
  await build({ entryPoints: [join(SETTINGS, "device-link-model.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  m = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
});

const sync = (deviceId, name, tier) => ({ deviceId, name, tier });
const checkedIds = (c) => c.filter((x) => x.checked).map((x) => x.deviceId);

test("platform comes from the Live Chat name; unknown names say nothing", () => {
  assert.equal(m.livePlatform("iPhone"), "ios");
  assert.equal(m.livePlatform("Dinesh's iPad"), "ios");
  assert.equal(m.livePlatform("Chrome on Mac"), "web");
  assert.equal(m.livePlatform("Pixel"), null);
});

test("Live Chat revoke pre-checks the same-platform name match, else the only device of that platform", () => {
  const live = { deviceId: "l1", name: " MY  iPhone " };
  assert.deepEqual(checkedIds(m.offlineCandidates(live, [sync("a", "my iphone", "ios"), sync("b", "Other", "ios"), sync("c", "my iphone", "web")])), ["a"]);
  assert.deepEqual(checkedIds(m.offlineCandidates({ deviceId: "l1", name: "iPhone" }, [sync("a", "Work phone", "ios"), sync("c", "Browser", "web")])), ["a"]);
});

test("never pre-checks more than one, and never across platforms or on unknown platform", () => {
  const two = [sync("a", "Phone 1", "ios"), sync("b", "Phone 2", "ios")];
  assert.deepEqual(checkedIds(m.offlineCandidates({ deviceId: "l", name: "iPhone" }, two)), []);
  assert.deepEqual(checkedIds(m.offlineCandidates({ deviceId: "l", name: "iPhone" }, [sync("a", "x", "ios"), sync("b", "x", "ios")].map((s) => ({ ...s, name: "iphone" })))), [], "two name matches");
  assert.deepEqual(checkedIds(m.offlineCandidates({ deviceId: "l", name: "iPhone" }, [sync("a", "iPhone", "web")])), []);
  assert.deepEqual(checkedIds(m.offlineCandidates({ deviceId: "l", name: "Pixel" }, [sync("a", "Pixel", "ios")])), []);
  assert.equal(m.offlineCandidates({ deviceId: "l", name: "iPhone" }, two).length, 2, "all stay selectable");
});

test("sync revoke offers the Live Chat devices with the same rule", () => {
  const live = [{ deviceId: "l1", name: "iPhone" }, { deviceId: "l2", name: "Safari" }];
  assert.deepEqual(checkedIds(m.liveCandidates(sync("s", "Mine", "ios"), live)), ["l1"]);
  assert.deepEqual(checkedIds(m.liveCandidates(sync("s", "Mine", "web"), live)), ["l2"]);
  assert.deepEqual(checkedIds(m.liveCandidates(sync("s", "Mine", "ios"), [{ deviceId: "p", name: "Pixel" }])), []);
});

test("runRevokes: a failed primary stops everything; a failed extra is reported by name and never as success", async () => {
  const ok = (label) => ({ label, run: async () => true });
  const boom = (label) => ({ label, run: async () => { throw new Error("offline"); } });
  const stopped = await m.runRevokes([boom("A"), ok("B")]);
  assert.deepEqual(stopped.map((o) => o.label), ["A"]);
  assert.equal(m.summarizeRevokes(stopped).ok, false);
  const partial = await m.runRevokes([ok("A"), boom("B"), ok("C")]);
  const s = m.summarizeRevokes(partial);
  assert.equal(s.ok, false);
  assert.match(s.text, /Removed A, C\./);
  assert.match(s.text, /Could not remove B \(offline\)\./);
  const unconfirmed = m.summarizeRevokes(await m.runRevokes([{ label: "A", run: async () => false }]));
  assert.equal(unconfirmed.ok, false);
  assert.equal(m.summarizeRevokes(await m.runRevokes([ok("A"), ok("B")])).text, "Removed A, B.");
});
