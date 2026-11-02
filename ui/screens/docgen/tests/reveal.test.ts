// A failed Reveal is not silent: section.tsx shows REVEAL_FAILED through the screen's banner. The Reveal call is
// unchanged (project-relative path, host command); only its failure path is new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REVEAL_FAILED } from "../reveal.ts";

const src = (f: string) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8");

test("the notice is the plain sentence the rest of the app uses", () => {
  assert.equal(REVEAL_FAILED, "The file could not be shown in the file manager.");
});

test("a failed reveal sets the notice; a successful one clears it; the old silent catch is gone", () => {
  const section = src("section.tsx");
  assert.doesNotMatch(section, /reveal_in_os", \{ relPath: rel \}\)\.catch\(\(\) => undefined\)/);
  assert.match(section, /invokeHost\("reveal_in_os", \{ relPath: rel \}\)\.then\(\(\) => undefined, \(\) => setRevealNotice\(REVEAL_FAILED\)\)/);
  assert.match(section, /if \(!rel\) \{ setRevealNotice\(REVEAL_FAILED\); return; \}/);
});

test("an unsafe path also reports the notice rather than doing nothing", () => {
  assert.match(src("section.tsx"), /if \(!rel\) \{ setRevealNotice\(REVEAL_FAILED\); return; \}/);
});

test("the screen renders the notice as an error banner", () => {
  assert.match(src("DocGenScreen.tsx"), /\{p\.revealNotice && <StatusBanner severity="error" message=\{<>\{p\.revealNotice\}<\/>\} \/>\}/);
  assert.match(src("section.tsx"), /revealNotice=\{revealNotice\}/);
});
