import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_QUEUED_NOTE, BOARD_STARTED_NOTE, handleBoardRunRequest } from "../native/board-run-request.ts";
import { initialProjectStore } from "../native/templates.ts";

const store = initialProjectStore("npm test");
const testLoop = store.loops.find((l) => l.defaultKey === "test");
const factory = store.loops.find((l) => l.defaultKey === "factory");

/** The deps of a request with no Loop page anywhere: only the run manager's start and the answer channel. */
function world(over = {}) {
  const w = { started: [], answers: [], listeners: new Set(), has: false, busy: false };
  w.deps = {
    projectRoot: () => "/p",
    loadLoops: async () => ({ kind: "ok", store, hash: "h" }),
    loopHasRun: () => w.has,
    loopRunActive: () => w.busy,
    start: (root, item) => { w.started.push({ root, item }); return "run-1"; },
    subscribeEvents: (l) => { w.listeners.add(l); return () => w.listeners.delete(l); },
    tell: (a) => w.answers.push(a),
    ...over,
  };
  w.emit = (e) => { for (const l of [...w.listeners]) l(e); };
  return w;
}

test("a board request starts the run through the manager with the loop's run item, and the board hears it started", async () => {
  const w = world();
  await handleBoardRunRequest({ loopId: testLoop.id, inputPath: " ./src\\a/ ", task: "  fix it  " }, w.deps);
  assert.equal(w.started.length, 1);
  assert.equal(w.started[0].root, "/p");
  assert.equal(w.started[0].item.key, `loop:${testLoop.id}`);
  assert.deepEqual(w.started[0].item.loop, { loopId: testLoop.id, command: "fix it", inputPath: "src/a" });
  assert.deepEqual(w.answers, [{ loopName: testLoop.name, loopId: testLoop.id, message: BOARD_STARTED_NOTE, started: true }]);
});

test("a request while another loop run is active is queued, and says so without the started flag", async () => {
  const w = world();
  w.busy = true;
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  assert.equal(w.started.length, 1);
  assert.deepEqual(w.answers, [{ loopName: testLoop.name, loopId: testLoop.id, message: BOARD_QUEUED_NOTE }]);
});

test("refusals are answered to the board and start nothing", async () => {
  let w = world({ projectRoot: () => null });
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  assert.match(w.answers[0].message, /Open a project/);

  w = world({ loadLoops: async () => ({ kind: "corrupt", message: "bad json" }) });
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  assert.match(w.answers[0].message, /could not be loaded: bad json/);

  w = world({ loadLoops: async () => { throw new Error("disk"); } });
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  assert.match(w.answers[0].message, /disk/);

  w = world();
  await handleBoardRunRequest({ loopId: "nope" }, w.deps);
  assert.match(w.answers[0].message, /no longer exists/);

  w = world();
  await handleBoardRunRequest({ loopId: factory.id }, w.deps);
  assert.match(w.answers[0].message, /Factory board/);

  w = world();
  await handleBoardRunRequest({ loopId: testLoop.id, inputPath: "../x" }, w.deps);
  assert.match(w.answers[0].message, /\.\./);

  w = world();
  w.has = true;
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  assert.match(w.answers[0].message, /already has a run/);
  assert.deepEqual(w.started, []);
});

test("a run the manager refuses later is answered when it ends; a run that went through is not", async () => {
  let w = world();
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  w.emit({ type: "finished", runId: "other", refused: true, notice: "not mine" });
  w.emit({ type: "finished", runId: "run-1", refused: true, notice: "The loop's commands were not approved." });
  assert.equal(w.answers.at(-1).message, "The loop's commands were not approved.");
  assert.equal(w.answers.at(-1).started, undefined, "a refusal re-enables the board's Run");
  assert.equal(w.listeners.size, 0, "the listener is dropped once its run ended");

  w = world();
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  const before = w.answers.length;
  w.emit({ type: "finished", runId: "run-1", refused: false, notice: "The loop passed.", manualShip: { info: {} } });
  assert.equal(w.answers.length, before, "a run that went through (here: held for review) shows its own card");
  w = world();
  await handleBoardRunRequest({ loopId: testLoop.id }, w.deps);
  w.emit({ type: "finished", runId: "run-1", refused: false, notice: "boom", manualShip: null });
  w.emit({ type: "finished", runId: "run-1", refused: false, notice: "boom again", manualShip: null });
  assert.equal(w.answers.filter((a) => a.message.startsWith("boom")).length, 1, "a run that threw answers the board once");
});

test("the shell handles the request itself: no Loop page source is involved", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const shell = read("../../shell/Shell.tsx");
  assert.match(shell, /import\("\.\.\/loop\/native\/board-run-wiring\.ts"\)/);
  assert.doesNotMatch(shell, /subscribe\("run-loop"/, "the shell no longer mounts the Loop page for a board request");
  assert.equal(/board-run/.test(read("../native/NativeLoopScreen.tsx")), false);
  const wiring = read("../native/board-run-wiring.ts");
  assert.match(wiring, /takePending\("run-loop"\)/, "a request published before the handler loaded is not lost");
  assert.match(wiring, /startRun\(root, item, "full"\)/);
});
