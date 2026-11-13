// Reads/writes `<project>/system/loop.json` through the root-confined host fs. Mirrors the Swift
// LoopEngineConfigStore contract at the file level: current schema first, legacy bare config next, corrupt files are
// reported and never overwritten silently. The desktop UI owns the edit; the Mac remains able to read the same file.
import type { FsApi } from "../../explorer/fs";
import { decodeProjectStore, encodeProjectStore, type LoopProjectStore } from "./model.ts";

export const LOOP_FILE = "system/loop.json";

export type LoopFs = Pick<FsApi, "read" | "write">;

export type LoopLoad =
  | { kind: "ok"; store: LoopProjectStore; hash: string }
  | { kind: "missing" }
  | { kind: "corrupt"; message: string };

function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
}

export async function loadLoops(fs: LoopFs, path = LOOP_FILE): Promise<LoopLoad> {
  let read;
  try {
    read = await fs.read(path, 4_000_000);
  } catch (e) {
    if (codeOf(e) === "missing" || codeOf(e) === "not_found") return { kind: "missing" };
    throw e;
  }
  if (read.status !== "ok" || read.text === null || read.hash === null) {
    return { kind: "corrupt", message: "system/loop.json is not readable UTF-8 text." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return { kind: "corrupt", message: "system/loop.json is not valid JSON." };
  }
  const store = decodeProjectStore(raw);
  return store ? { kind: "ok", store, hash: read.hash } : { kind: "corrupt", message: "system/loop.json has an unknown Loop schema." };
}

export async function saveLoops(fs: LoopFs, store: LoopProjectStore, expectedHash: string | null, path = LOOP_FILE): Promise<{ hash: string }> {
  const r = await fs.write(path, encodeProjectStore(store), { expected_hash: expectedHash, encoding: "utf-8", bom: false });
  return { hash: r.hash };
}

/** The loop containing a stage, across every loop (the Mac's "run just this stage" lookup). */
export function loopContaining(store: LoopProjectStore, stageId: string) {
  return store.loops.find((l) => l.config.stages.some((s) => s.id === stageId)) ?? null;
}

/** The Primary loop, or the first loop when none is marked (the Mac's fallback). */
export function primaryLoop(store: LoopProjectStore) {
  return store.loops.find((l) => l.isPrimary) ?? store.loops[0] ?? null;
}

/** Manual-only follows the recipe: the Refactoring built-in or any enabled code-applying stage. */
const CODE_APPLY_SKILLS = new Set(["skills/refactor-apply", "skills/test-gap-writer", "skills/test-structure-setup", "skills/refactor-conform"]);
export function isManualOnly(loop: LoopProjectStore["loops"][number]): boolean {
  return loop.defaultKey === "refactor" || loop.config.stages.some((s) => s.enabled && s.kind === "skill" && s.skillId !== null && CODE_APPLY_SKILLS.has(s.skillId) && s.skillId !== "skills/test-gap-writer");
}

/**
 * Skills that apply refactor batches. The Mac restores a failed batch's own paths (its Mikado rollback); the desktop
 * instead runs such a loop in an isolated worktree, where a failed batch never reaches the main tree and discarding
 * the worktree is the rollback.
 */
const BATCH_SKILLS = new Set(["skills/refactor-apply", "skills/refactor-conform"]);
export function isBatchSkill(skillId: string | null): boolean {
  return skillId !== null && BATCH_SKILLS.has(skillId);
}
/** Why a run that applies refactor batches cannot start, or null when it may (or applies none). */
export function batchRollbackReason(loop: LoopProjectStore["loops"][number]): string | null {
  // Only an ENABLED batch stage needs this: with Refactor Apply/Conform off the loop only plans and checks.
  const ordered = [...loop.config.stages].sort((a, b) => a.order - b.order);
  const first = ordered.findIndex((s) => s.enabled && s.kind === "skill" && isBatchSkill(s.skillId));
  if (first === -1) return null;
  if (!loop.config.alwaysUseWorktree) {
    return `“${loop.name}” applies refactor batches, so it must run in an isolated worktree, where a failed batch is discarded instead of left half-applied in your tree. Turn on “Always run in an isolated worktree” in its options.`;
  }
  // Code is never edited without a stage after it that runs the tests.
  if (!ordered.slice(first + 1).some((s) => s.enabled && s.kind === "shellCommand" && s.severity === "blocking" && (s.command ?? "").trim() !== "")) {
    return `“${loop.name}” applies refactor batches but has no test stage after them, so nothing would check the change. Add the project's test command as a Test stage after Refactor Apply, or turn off Refactor Apply and Refactor Conform to only plan.`;
  }
  return null;
}
