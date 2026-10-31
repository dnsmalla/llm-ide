import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DecodeError, decodeActive, decodeCatalog, decodeCheck, decodeInstalled, decodeItem, decodeItemResult, decodeOk, decodePreview, decodeRefresh, decodeRepair, decodeRollback, decodeUpdateApplied, decodeUpdates,
} from "../decoders.ts";
import { cleanText, capChars, hasUnsafeChars } from "../sanitize.ts";
import { allFixtureNames, fx } from "./helpers.ts";

// Every fixture under schema/http/fixtures/extensions is covered: success bodies by a decoder, error bodies
// by the error envelope, allowlist and workspace-trust by the Settings screen's decoders (that slice owns them).
const DECODERS: Record<string, (b: unknown) => unknown> = {
  "GET /auth/me/extensions/installed": decodeInstalled,
  "POST /auth/me/extensions/install": decodeItemResult,
  "POST /auth/me/extensions/toggle": decodeItemResult,
  "POST /auth/me/extensions/uninstall": decodeOk,
  "GET /auth/me/extensions/catalog": decodeCatalog,
  "POST /auth/me/extensions/catalog/refresh": decodeRefresh,
  "GET /auth/me/extensions/active": decodeActive,
  "GET /auth/me/extensions/updates": decodeUpdates,
  "POST /auth/me/extensions/updates/check": decodeCheck,
  "POST /auth/me/extensions/update/preview": decodePreview,
  "POST /auth/me/extensions/update": decodeUpdateApplied,
  "POST /auth/me/extensions/rollback": decodeRollback,
  "POST /auth/me/extensions/repair": decodeRepair,
};
const SETTINGS_OWNED = /allowlist|workspace-trust/;

test("every 200 fixture of the Extensions routes decodes", () => {
  let decoded = 0;
  for (const name of allFixtureNames()) {
    const f = fx(name);
    if (SETTINGS_OWNED.test(name) || f.status !== 200) continue;
    const dec = DECODERS[f.endpoint];
    assert.ok(dec, `no decoder for ${f.endpoint} (${name})`);
    assert.doesNotThrow(() => dec(f.response), name);
    decoded++;
  }
  assert.ok(decoded >= 24, `decoded only ${decoded} fixtures`);
});

test("every error fixture has the envelope shape the screen maps", () => {
  let n = 0;
  for (const name of allFixtureNames()) {
    const f = fx(name);
    if (SETTINGS_OWNED.test(name) || f.status < 400) continue;
    const env = (f.response as { error?: { code?: unknown } }).error;
    assert.equal(typeof env?.code, "string", name);
    n++;
  }
  assert.ok(n >= 20);
});

test("allowlist and workspace-trust fixtures are decoded by the Settings decoders", async () => {
  const s = await import("../../../settings/decoders.ts");
  for (const name of allFixtureNames()) {
    const f = fx(name);
    if (!SETTINGS_OWNED.test(name) || f.status !== 200) continue;
    if (name.includes("allowlist")) assert.doesNotThrow(() => s.decodeAllowlist(f.response), name);
    else if (name.startsWith("get-")) assert.doesNotThrow(() => s.decodeWorkspaceTrustList(f.response), name);
    else assert.doesNotThrow(() => s.decodeWorkspaceTrustSet(f.response), name);
  }
});

test("installed items keep the fields the screen shows", () => {
  const list = decodeInstalled(fx("get-auth-me-extensions-installed-200-2").response);
  const sketchy = list.items.find((i) => i.id === "plugin:acme/sketchy");
  assert.ok(sketchy);
  assert.equal(sketchy.scan.count, 3);
  assert.equal(sketchy.scan.findings[0]?.rule, "pipe_to_shell");
  assert.equal(sketchy.pinnedCommit, "e".repeat(40));
  assert.equal(sketchy.enabled, false);
});

test("preview carries the diff, new executable kinds and the consent it needs", () => {
  const p = decodePreview(fx("post-auth-me-extensions-update-preview-200").response);
  assert.equal(p.from, "e".repeat(40));
  assert.equal(p.to, "f".repeat(40));
  assert.deepEqual(p.consent, { required: true, kinds: ["hook"] });
  assert.deepEqual(p.newKinds, ["hook"]);
  assert.equal(p.files.added.length, 2);
  assert.equal(p.scan.newFindings[0]?.rule, "injection_phrase");
});

test("wrong shapes are DecodeErrors, never half-typed objects", () => {
  assert.throws(() => decodeInstalled(null), DecodeError);
  assert.throws(() => decodeInstalled({ corrupt: false, items: [{}] }), DecodeError);
  assert.throws(() => decodeCatalog({ query: "", total: "3", offset: 0, results: [], sources: [] }), DecodeError);
  const good = fx("get-auth-me-extensions-installed-200-2").response as { items: Record<string, unknown>[] };
  // a commit that is not 40-hex must not reach a request body
  assert.throws(() => decodeItem({ ...good.items[0], pinnedCommit: "main" }), DecodeError);
  // an id with a control or bidi character is refused, not edited (it is sent back verbatim)
  assert.throws(() => decodeItem({ ...good.items[0], id: "plugin:acme/ru‮nner" }), DecodeError);
  assert.throws(() => decodeItem({ ...good.items[0], id: "plugin:acme/run\nner" }), DecodeError);
});

test("hostile text is cleaned and capped at the boundary", () => {
  const good = fx("get-auth-me-extensions-installed-200-2").response as { items: Record<string, unknown>[] };
  const it = decodeItem({ ...good.items[0], name: "evil‮\u0000name​", description: "x".repeat(5000) + "\u0007" });
  assert.equal(it.name, "evilname");
  assert.ok(it.description.length <= 300);
  assert.equal(hasUnsafeChars(it.description), false);
  assert.equal(cleanText("a\nb\tc"), "a b c");
  assert.equal(cleanText("⁦x⁩"), "x");
  assert.equal(capChars("😀😀😀😀", 3), "😀😀…");
});

test("lists are capped: a huge diff or finding list cannot flood the page", () => {
  const p = fx("post-auth-me-extensions-update-preview-200").response as { files: { added: unknown[] } };
  const added = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}`, size: 1 }));
  const dec = decodePreview({ ...p, files: { ...p.files, added } });
  assert.equal(dec.files.added.length, 200);
  const cat = fx("get-auth-me-extensions-catalog-200-2").response as { results: unknown[] };
  const many = Array.from({ length: 1000 }, () => (cat.results as unknown[])[0]);
  assert.equal(decodeCatalog({ ...cat, results: many }).results.length, 100);
});

test("the active summary exposes counts, never configs", () => {
  const a = decodeActive(fx("get-auth-me-extensions-active-200").response);
  assert.equal(a.items, 2);
  assert.equal(a.skills, 2);
  assert.equal(a.mcpServers, 0);
  assert.equal(a.failClosed, false);
});
