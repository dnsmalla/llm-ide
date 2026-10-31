import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsRegistry } from "../registry.ts";
import {
  LTA_MODES, LTA_TEXT, buildDiagnostics, coreTrustLabel, coreTrustTone, featureRows, isLtaMode, ltaNeedsRestart, needsOffConfirm,
} from "../misc-model.ts";
import { decodeHealth, decodeMe } from "../decoders.ts";
import { fixture } from "./helpers.ts";

const load = (name: string) => async () => ({ default: name });

test("registry: sections sort by order then id; duplicates are refused", () => {
  const r = new SettingsRegistry<string>();
  r.registerSection({ id: "b", title: "B", order: 2, load: load("b") });
  r.registerSection({ id: "a", title: "A", order: 2, load: load("a") });
  r.registerSection({ id: "z", title: "Z", order: 1, load: load("z") });
  assert.deepEqual(r.sections().map((s) => s.id), ["z", "a", "b"]);
  assert.throws(() => r.registerSection({ id: "a", title: "A", order: 0, load: load("a") }), /already registered/);
});

test("registry: another screen contributes a card without editing Settings; orphans are detectable", () => {
  const r = new SettingsRegistry<string>();
  let hits = 0;
  r.subscribe(() => hits++);
  r.registerSection({ id: "extensions", title: "Extensions", order: 1, load: load("e") });
  r.registerCard("extensions", { id: "mcp-consent", title: "MCP consent", order: 5, load: load("c") });
  r.registerCard("extensions", { id: "hooks", title: "Hooks", order: 1, load: load("h") });
  r.registerCard("typo", { id: "x", title: "X", order: 0, load: load("x") });
  assert.deepEqual(r.cardsFor("extensions").map((c) => c.id), ["hooks", "mcp-consent"]);
  assert.deepEqual(r.orphanCards(), ["typo"]);
  assert.throws(() => r.registerCard("extensions", { id: "hooks", title: "again", order: 0, load: load("h") }), /already registered/);
  assert.equal(hits, 4);
  assert.equal(r.version(), 4);
});

test("registry: loaders are lazy (not called at registration)", async () => {
  let loaded = 0;
  const r = new SettingsRegistry<string>();
  r.registerSection({ id: "a", title: "A", order: 0, load: async () => { loaded++; return { default: "A" }; } });
  assert.equal(loaded, 0);
  assert.equal((await r.section("a")!.load()).default, "A");
  assert.equal(loaded, 1);
});

test("live-then-archive: off-confirm rule, restart note, parsing", () => {
  assert.equal(needsOffConfirm("on", "off", "off"), true);
  assert.equal(needsOffConfirm("shadow", "on", "off"), true);
  assert.equal(needsOffConfirm("shadow", "shadow", "off"), false);
  assert.equal(needsOffConfirm("off", "off", "on"), false);
  assert.equal(ltaNeedsRestart("on", "shadow"), true);
  assert.equal(ltaNeedsRestart("on", "on"), false);
  assert.ok(LTA_MODES.every(isLtaMode));
  assert.equal(isLtaMode("ON"), false);
  assert.match(LTA_TEXT.explanation("on"), /removed|removes/);
});

test("features: null means all on; a list is shown sorted and read-only", () => {
  const h = decodeHealth(fixture("health-auth/get-health-200.json").response);
  assert.equal(featureRows(h).allOn, true);
  const some = featureRows({ ...h, features: ["library", "chat"] });
  assert.deepEqual(some.enabled, ["chat", "library"]);
  assert.match(some.note, /next time the backend starts/);
  assert.match(featureRows(null).note, /unknown/);
});

test("core trust states are told apart", () => {
  assert.match(coreTrustLabel("spawned"), /identity verified/);
  assert.match(coreTrustLabel("adopted-unverified"), /Adopted \(unverified\)/);
  assert.equal(coreTrustTone("spawned"), "ok");
  assert.equal(coreTrustTone("adopted-unverified"), "warning");
});

test("diagnostics carry versions and states but no secrets, even if a path or field held one", () => {
  const h = decodeHealth(fixture("health-auth/get-health-200.json").response);
  const me = decodeMe(fixture("health-auth/get-auth-me-200.json").response);
  const text = buildDiagnostics(
    { appVersion: "0.1.0", coreTrust: "adopted-unverified", coreLogPath: "/Users/x/Library/Logs/core.log?token=abcd1234efgh", platform: "darwin" },
    h, me, new Date("2026-10-31T00:00:00Z"),
  );
  assert.match(text, /App version: 0.1.0/);
  assert.match(text, /Adopted \(unverified\)/);
  assert.match(text, /API version: 80/);
  assert.match(text, /Signed in: yes/);
  assert.ok(!text.includes("abcd1234efgh"));
  assert.ok(!text.includes("capture-user@example.com"), "no e-mail address in diagnostics");
  assert.ok(!/accessToken|refreshToken|password/i.test(text));
});
