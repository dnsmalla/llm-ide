// Settings stays reachable with the core down, only in ssh mode and only for the Settings section. Every other gate
// and mode keeps the overlay and the inert content as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const { settingsReachableOverCoreDown, sectionInert } = await load("gate.ts");
const { SectionSlot } = await load("Shell.tsx");
const { SECTIONS } = await load("sections.ts");

test("ssh + core down + Settings: Settings is reachable", () => {
  assert.equal(settingsReachableOverCoreDown("ssh", "core", "settings"), true);
});

test("ssh + core down + another section: the overlay stays as before", () => {
  assert.equal(settingsReachableOverCoreDown("ssh", "core", "explorer"), false);
});

test("local or remote + core down + Settings: the overlay stays as before", () => {
  assert.equal(settingsReachableOverCoreDown("local", "core", "settings"), false);
  assert.equal(settingsReachableOverCoreDown("remote", "core", "settings"), false);
  assert.equal(settingsReachableOverCoreDown(undefined, "core", "settings"), false);
});

test("ssh + login or restarting or open gates: unchanged (not the core gate)", () => {
  for (const gate of ["login", "restarting", "open"]) {
    assert.equal(settingsReachableOverCoreDown("ssh", gate, "settings"), false, gate);
  }
});

test("sections: only Settings is exempt from inert, and only while reachable", () => {
  assert.equal(sectionInert("core", "settings", true), false);
  assert.equal(sectionInert("core", "settings", false), true);
  assert.equal(sectionInert("core", "explorer", true), true, "other sections stay inert");
  assert.equal(sectionInert("login", "settings", true), true, "the login gate is not exempt");
  assert.equal(sectionInert("open", "explorer", false), false);
});

test("rendered: Settings' section wrapper is visible and not inert while reachable; others are inert", () => {
  const settings = SECTIONS.find((s) => s.id === "settings");
  const explorer = SECTIONS.find((s) => s.id === "explorer");
  const reachable = renderToStaticMarkup(h(SectionSlot, { def: settings, active: true, projectRoot: null, inert: sectionInert("core", "settings", true), spike: () => null }));
  assert.match(reachable, /data-section="settings"/);
  assert.doesNotMatch(reachable, /\binert\b/, "Settings is not inert");
  assert.doesNotMatch(reachable, / hidden[ >=]/, "Settings is shown");
  const other = renderToStaticMarkup(h(SectionSlot, { def: explorer, active: false, projectRoot: null, inert: sectionInert("core", "explorer", true), spike: () => null }));
  assert.match(other, /\binert\b/);
});
