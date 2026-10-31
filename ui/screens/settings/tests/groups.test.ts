import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_GROUPS, APP_GROUPS, ExpandedGroups, MERGED_MAC_CARDS, PROJECT_GROUPS, expandedKey, resolveAnchor } from "../groups.ts";
import { NOTICES, PARTIAL_NOTES } from "../notices.ts";
// @ts-expect-error plain .mjs script
import { extractSettingsGroups } from "../../../../scripts/extract-settings-groups.mjs";

type MacCard = { title: string; sf: string };
const mac = extractSettingsGroups() as { app: MacCard[]; project: MacCard[] };
const withoutMerged = (cards: MacCard[]) => cards.filter((c) => !(c.title in MERGED_MAC_CARDS));

test("parity: the desktop App groups are the Mac's App page, same titles in the same order (drift fails here)", () => {
  assert.deepEqual(APP_GROUPS.map((g) => g.title), withoutMerged(mac.app).map((c) => c.title));
});

test("parity: the Project groups match the Mac's Project block", () => {
  assert.deepEqual(PROJECT_GROUPS.map((g) => g.title), withoutMerged(mac.project).map((c) => c.title));
});

test("parity: the recorded SF Symbol of every group is the Mac's", () => {
  const macSf = new Map([...mac.app, ...mac.project].map((c) => [c.title, c.sf]));
  for (const g of ALL_GROUPS) assert.equal(g.sf, macSf.get(g.title), g.title);
});

test("parity: every folded Mac card names a real desktop group", () => {
  const ids = new Set(ALL_GROUPS.map((g) => g.id));
  for (const [card, id] of Object.entries(MERGED_MAC_CARDS)) {
    assert.ok(ids.has(id), `${card} -> ${id}`);
    assert.ok([...mac.app, ...mac.project].some((c) => c.title === card), `${card} is no longer on the Mac page`);
  }
});

test("group ids are unique and storage-safe; every non-working group has a notice, every partial one a note", () => {
  const ids = ALL_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);
  for (const g of ALL_GROUPS) {
    if (g.status === "host" || g.status === "mac-only" || (g.status === "core-route") || g.id === "connections") assert.ok(NOTICES[g.id], `notice for ${g.id}`);
    if (g.status === "partial" && g.id !== "connections") assert.ok(PARTIAL_NOTES[g.id], `partial note for ${g.id}`);
  }
  for (const id of Object.keys(NOTICES)) assert.ok(ids.includes(id), `notice for unknown group ${id}`);
});

test("resolveAnchor: ids, settings:<id>, old anchors; hostile or unknown input is null", () => {
  assert.equal(resolveAnchor("providers"), "providers");
  assert.equal(resolveAnchor("settings:workspace"), "workspace");
  assert.equal(resolveAnchor("about"), "updates");
  assert.equal(resolveAnchor("routing"), "model-routing");
  assert.equal(resolveAnchor("extensions-trust"), "folder-trust");
  for (const bad of ["", "settings:", "nope", "../x", "__proto__", "constructor", "settings:__proto__", "x".repeat(100), null, undefined]) {
    assert.equal(resolveAnchor(bad as string | null | undefined), null, String(bad));
  }
});

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

test("expanded state: default collapsed, remembered per group id, toggles", () => {
  const s = store();
  const e = new ExpandedGroups(s);
  assert.equal(e.isOpen("providers"), false);
  assert.equal(e.toggle("providers"), true);
  assert.equal(s.m.get(expandedKey("providers")), "true");
  assert.equal(new ExpandedGroups(s).isOpen("providers"), true);
  assert.equal(new ExpandedGroups(s).isOpen("general"), false);
  e.set("providers", false);
  assert.equal(new ExpandedGroups(s).isOpen("providers"), false);
});

test("expanded state survives hostile storage: throwing, absent, or returning junk", () => {
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
  const e = new ExpandedGroups(throwing);
  assert.equal(e.isOpen("a"), false);
  assert.equal(e.toggle("a"), true); // session-only
  assert.equal(e.isOpen("a"), true);
  const none = new ExpandedGroups(null);
  none.set("b", true);
  assert.equal(none.isOpen("b"), true);
  for (const junk of ["", "TRUE", "1", "yes", "{}", "null", "true ", "\u0000"]) assert.equal(new ExpandedGroups(store({ [expandedKey("a")]: junk })).isOpen("a"), false, JSON.stringify(junk));
});

test("every Settings deep link in the app source names a real group", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n === "tests") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(root);
  const found: string[] = [];
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/section: "settings", anchor: "([^"]+)"/g)) found.push(m[1]!);
  assert.ok(found.length >= 2, "expected at least the status bar and Doc Gen links");
  for (const a of found) assert.notEqual(resolveAnchor(a), null, `anchor "${a}"`);
});

test("the mirror map documents every group and every blocked-by sentence verbatim", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const doc = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), "docs/superpowers/plans/2026-10-31-settings-mirror-map.md"), "utf8");
  for (const g of ALL_GROUPS) assert.ok(doc.includes(`| ${g.title}`), `map row for ${g.title}`);
  for (const [id, n] of Object.entries(NOTICES)) assert.ok(doc.includes(n.blockedBy.replaceAll("|", "\\|")), `blocked-by for ${id}`);
});
