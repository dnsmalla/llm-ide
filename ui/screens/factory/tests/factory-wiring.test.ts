import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the conflicts section loads the Factory screen, is labelled Factory and stays ungated", () => {
  const screens = read("../../shell/screens.tsx");
  assert.match(screens, /conflicts: \(\) => import\("\.\.\/factory\/index\.tsx"\),/);
  assert.equal(screens.includes('import("../review/index.tsx")'), false, "the old screen is a tab now, not the section");
  assert.match(read("../../shell/sections.ts"), /\{ id: "conflicts", label: "Factory", enabled: true \}/);
  assert.equal(/case "conflicts"/.test(read("../../shell/features.ts")), false, "featureForSection(\"conflicts\") stays null");
});

test("factory screen hides the Board tab when auto_tasks is not usable", () => {
  const src = read("../FactoryScreen.tsx");
  assert.match(src, /const Board = typeof __FEATURE_AUTO_TASKS__ === "undefined" \|\| __FEATURE_AUTO_TASKS__ \? lazy\(\(\) => import\("\.\/Board\.tsx"\)\) : null;/, "a build without Loop drops the Board chunk");
  assert.match(src, /const boardUsable = Board !== null && features\.usable\.has\("auto_tasks"\);/);
  assert.match(src, /\{boardUsable \? <button type="button" role="tab"/, "the Board tab exists only when usable");
  assert.match(src, /<Review active=\{active && shown === "docs"\} projectRoot=\{projectRoot\} \/>/, "Docs vs code is always rendered");
});

test("status refresh interval is cleared on hide", () => {
  const board = read("../Board.tsx");
  assert.match(board, /if \(!active\) return;\s*void loadFacts\(\)\.then\(\(\) => refreshStatus\(\)\);\s*const timer = setInterval\(\(\) => void refreshStatus\(\), STATUS_REFRESH_MS\);\s*return \(\) => clearInterval\(timer\);/);
  assert.match(read("../board-model.ts"), /export const STATUS_REFRESH_MS = 5 \* 60 \* 1000;/);
  assert.match(read("../FactoryScreen.tsx"), /<Board active=\{active && shown === "board"\}/, "the board is inactive while the Docs tab is shown");
});

test("the board installs the run manager host and records a Ship on the run record", () => {
  const board = read("../Board.tsx");
  assert.match(board, /\ninstallRunManagerHost\(\);/, "startRun throws without the host wiring");
  assert.match(board, /setRunRecordShip\(fs, entry, r\)/, "a Ship is written to the run record so the card moves to Shipped");
  assert.match(board, /<ShipPanel\s[\s\S]*passed=\{[\s\S]*runPrefix=\{[\s\S]*onShipped=\{[\s\S]*onDiscarded=\{[\s\S]*onClose=\{/);
});

test("the entry takes a pending focus request from the shell bus, then live ones", () => {
  const entry = read("../index.tsx");
  assert.match(entry, /take\(shellBus\.takePending\("goto-section"\)\);/);
  assert.match(entry, /if \(ev && ev\.section === "conflicts"\)/);
});
