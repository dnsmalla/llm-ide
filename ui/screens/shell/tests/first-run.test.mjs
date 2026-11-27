import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const { shouldOpenGuideOnFirstRun, markGuideSeen } = await load("first-run.ts");
const { GuideDialog } = await load("../welcome/HelpGuide.tsx");
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)) }; };

test("first run: opens once, then never again", () => {
  const s = memory();
  assert.equal(shouldOpenGuideOnFirstRun(s), true);
  markGuideSeen(s);
  assert.equal(shouldOpenGuideOnFirstRun(s), false);
});

test("first run: missing or throwing storage never opens the guide", () => {
  assert.equal(shouldOpenGuideOnFirstRun(undefined), false);
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(shouldOpenGuideOnFirstRun(bad), false);
  assert.doesNotThrow(() => markGuideSeen(bad));
});

test("GuideDialog close button: Close by default, closeLabel when given", () => {
  const html = (p) => renderToStaticMarkup(React.createElement(GuideDialog, { onClose() {}, ...p }));
  assert.match(html({}), />Close<\/button>/);
  const out = html({ closeLabel: "Get started" });
  assert.match(out, />Get started<\/button>/);
  assert.doesNotMatch(out, />Close<\/button>/);
});

test("Shell takes the first-launch guide from the helper and skips it under the launch override", () => {
  const src = readFileSync(new URL("../Shell.tsx", import.meta.url), "utf8");
  assert.match(src, /useState\(\(\) => initialSection == null && shouldOpenGuideOnFirstRun\(\)\)/);
  assert.match(src, /markGuideSeen\(\)/);
});
