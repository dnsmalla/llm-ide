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
  assert.equal(src.includes("Docs vs code"), false, "the old review tab is removed");
});

test("status refresh interval is cleared on hide", () => {
  const board = read("../Board.tsx");
  assert.match(board, /if \(!active\) return;\s*void loadFacts\(\)\.then\(\(\) => refreshStatus\(\)\);\s*const timer = setInterval\(\(\) => void refreshStatus\(\), STATUS_REFRESH_MS\);\s*return \(\) => clearInterval\(timer\);/);
  assert.match(read("../board-model.ts"), /export const STATUS_REFRESH_MS = 5 \* 60 \* 1000;/);
  assert.match(read("../FactoryScreen.tsx"), /<Board active=\{active && shown === "board"\}/, "the board is inactive outside the Board tab");
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

test("the board's Input path has the same + folder picker as the Loop page, through the one shared helper", () => {
  const board = read("../LoopRuns.tsx");
  const loopPage = read("../../loop/native/NativeLoopScreen.tsx");
  for (const src of [board, loopPage]) {
    assert.match(src, /import \{ pickInputPath \} from "[^"]*pick-input-path\.ts";/);
    assert.match(src, /await pickInputPath\(/);
    assert.equal(/"pick_folder"/.test(src), false, "the picker protocol lives only in pick-input-path.ts");
  }
  assert.match(board, /<button type="button" className="fx-btn"[^>]*onClick=\{\(\) => void pickFolder\(\)\}>\+<\/button>/);
  assert.match(board, /invokeHost<string>\("loop_work_root"\)/, "the board resolves picks against the loops' work root, like the Loop page");
});

test("the loop-run board guards async results with the local alive flag and does not re-run its effect on a tick", () => {
  const src = read("../LoopRuns.tsx");
  assert.equal(/if \(!live\) return;/.test(src), false, "React state must not gate the load");
  assert.equal(/if \(live\) setError/.test(src), false);
  assert.match(src, /if \(!alive\) return;/);
  assert.equal(/\[fs, projectRoot, scope, tick, active\]/.test(src), false, "tick is not an effect dependency");
});
