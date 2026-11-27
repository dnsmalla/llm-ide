// A loop board's ▶ Run request (shell bus "run-loop"), answered without the Loop page: the loop is read from loop.json,
// checked, and handed to the background run manager like any other loop run. Every call is injected, so node tests load
// this module without the shell.
import { isFactoryLoop } from "./factory.ts";
import { loopUsesInputPath, normalizeInputPath } from "./input-path.ts";
import type { LoopLoad } from "./store.ts";
import type { LoopRunEvent, RunItem } from "./run-manager.ts";
import { loopRunItem } from "./run-manager.ts";

export interface BoardRunRequest { loopId: string; inputPath?: string; task?: string }

export interface BoardRunDeps {
  /** The open project's root, or null when none is open. */
  projectRoot(): string | null;
  loadLoops(projectRoot: string): Promise<LoopLoad>;
  /** True while this loop already has a run in the project, live or queued. */
  loopHasRun(projectRoot: string, loopId: string): boolean;
  /** True while a loop run of the project is executing (the new one will queue behind it). */
  loopRunActive(projectRoot: string): boolean;
  /** Starts the run (the run manager's startRun, after the host is installed) and returns its run id. */
  start(projectRoot: string, item: RunItem): string;
  subscribeEvents(listener: (e: LoopRunEvent) => void): () => void;
  /** The answer the requesting board shows. `started` keeps its ▶ Run disabled until the run shows up live. */
  tell(answer: { loopName: string; loopId: string; message: string; started?: boolean }): void;
}

/** What the board is told when the run is started now (an approval dialog may follow). */
export const BOARD_STARTED_NOTE = "Started. Approve the commands if a dialog asks.";
export const BOARD_QUEUED_NOTE = "Queued behind the current run.";

/** Answers one request: a refusal, "queued", or "started"; a run that is refused later is answered when it ends. */
export async function handleBoardRunRequest(req: BoardRunRequest, d: BoardRunDeps): Promise<void> {
  const say = (loopName: string, message: string, started?: boolean) => d.tell({ loopName, loopId: req.loopId, message, ...(started ? { started: true } : {}) });
  const root = d.projectRoot();
  if (!root) { say(req.loopId, "Open a project to run a loop."); return; }
  let load: LoopLoad;
  try { load = await d.loadLoops(root); } catch (e) { say(req.loopId, `The loops could not be loaded: ${e instanceof Error ? e.message : String(e)}`); return; }
  if (load.kind !== "ok") { say(req.loopId, `The loops could not be loaded: ${load.kind === "corrupt" ? load.message : "no loop file yet."}`); return; }
  const target = load.store.loops.find((l) => l.id === req.loopId);
  if (!target) { say(req.loopId, "That loop no longer exists."); return; }
  if (isFactoryLoop(target)) { say(target.name, "Use the Factory board's + Add to start a Factory run."); return; }
  let inputPath: string | undefined;
  if (req.inputPath !== undefined && loopUsesInputPath(target)) {
    const n = normalizeInputPath(req.inputPath);
    if ("error" in n) { say(target.name, n.error); return; }
    inputPath = n.path;
  }
  if (d.loopHasRun(root, target.id)) { say(target.name, `“${target.name}” already has a run in progress or queued; this request was not added.`); return; }
  const task = req.task?.trim() || undefined;
  const behind = d.loopRunActive(root);
  const runId = d.start(root, loopRunItem(target, { ...(task ? { command: task } : {}), ...(inputPath !== undefined ? { inputPath } : {}) }));
  // A start the run itself refuses (declined approval, a stage that cannot run) is answered when the run ends; a run that
  // went through shows its live card instead.
  const off = d.subscribeEvents((e) => {
    if (e.type !== "finished" || e.runId !== runId) return;
    off();
    // Refused, or a run that threw: its notice answers the board once. A run that went through shows its own card.
    if (e.notice && (e.refused || !e.manualShip)) say(target.name, e.notice);
  });
  if (behind) say(target.name, BOARD_QUEUED_NOTE);
  else say(target.name, BOARD_STARTED_NOTE, true);
}
