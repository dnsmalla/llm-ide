// Reads/writes `<project>/system/loop.json` through the root-confined host fs. Mirrors the Swift
// LoopEngineConfigStore contract at the file level: current schema first, legacy bare config next, corrupt files are
// reported and never overwritten silently. The desktop UI owns the edit; the Mac remains able to read the same file.
import type { FsApi } from "../../explorer/fs";
import { decodeProjectStore, encodeProjectStore, type LoopProjectStore } from "./model.ts";
import { decodeLessons, encodeLessons, LESSONS_FILE, lessonsOf, overlayLessons, SELF_IMPROVEMENT_DIR, withoutLessons, type LessonEntry } from "./lessons.ts";

export const LOOP_FILE = "system/loop.json";

/** `create` makes system/self-improvement/ the first time a lesson is saved; without it that save needs the folder. */
export type LoopFs = Pick<FsApi, "read" | "write"> & Partial<Pick<FsApi, "create">>;

export type LoopLoad =
  /** `lessonsProblem`: lessons.json exists but is unreadable, so loop.json's own lessons (if any) were used. */
  | { kind: "ok"; store: LoopProjectStore; hash: string; lessonsProblem?: string }
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
  if (!store) return { kind: "corrupt", message: "system/loop.json has an unknown Loop schema." };
  const lessons = await readLessons(fs);
  if (lessons.kind === "corrupt") {
    overlayLessons(store, []);
    return { kind: "ok", store, hash: read.hash, lessonsProblem: LESSONS_PROBLEM };
  }
  // A loop.json from before the move still carries lessons: move them now (lessons.json first, then loop.json without
  // them). A failed move changes nothing that matters: the lessons are on the stages either way and the next save
  // moves them.
  if (overlayLessons(store, lessons.kind === "ok" ? lessons.entries : []) && path === LOOP_FILE) {
    try { return { kind: "ok", store, hash: (await saveLoops(fs, store, read.hash, path)).hash }; } catch { /* moved on the next save */ }
  }
  return { kind: "ok", store, hash: read.hash };
}

const LESSONS_PROBLEM = "system/self-improvement/lessons.json is not a valid lessons file, so its lessons were not loaded. Fix or remove it; it is never overwritten.";

type LessonsRead = { kind: "missing" } | { kind: "ok"; entries: LessonEntry[]; hash: string } | { kind: "corrupt" };

async function readLessons(fs: LoopFs): Promise<LessonsRead> {
  let read;
  try {
    read = await fs.read(LESSONS_FILE, 4_000_000);
  } catch (e) {
    if (codeOf(e) === "missing" || codeOf(e) === "not_found") return { kind: "missing" };
    throw e;
  }
  if (read.status !== "ok" || read.text === null || read.hash === null) return { kind: "corrupt" };
  let entries: LessonEntry[] | null = null;
  try { entries = decodeLessons(JSON.parse(read.text)); } catch { /* corrupt below */ }
  return entries ? { kind: "ok", entries, hash: read.hash } : { kind: "corrupt" };
}

/**
 * Writes loop.json WITHOUT lessons, after writing them to system/self-improvement/lessons.json (lessons first, so a
 * failure in between never loses one: the file wins on the next load). A corrupt lessons file is never overwritten:
 * with lessons to save, the save is refused.
 */
export async function saveLoops(fs: LoopFs, store: LoopProjectStore, expectedHash: string | null, path = LOOP_FILE): Promise<{ hash: string }> {
  if (path === LOOP_FILE) {
    const current = await readLessons(fs);
    const hasLessons = store.loops.some((l) => l.config.stages.some((st) => typeof st.promptAddendum === "string" && st.promptAddendum.trim() !== ""));
    if (current.kind === "corrupt") {
      if (hasLessons) throw new Error(LESSONS_PROBLEM);
    } else {
      const entries = lessonsOf(store, current.kind === "ok" ? current.entries : [], new Date().toISOString());
      // Compared by content, so an unchanged file is never rewritten just to reformat it.
      if (current.kind === "ok" ? JSON.stringify(current.entries) !== JSON.stringify(entries) : entries.length > 0) {
        await writeLessons(fs, encodeLessons(entries), current.kind === "ok" ? current.hash : null);
      }
    }
  }
  const r = await fs.write(path, encodeProjectStore(path === LOOP_FILE ? withoutLessons(store) : store), { expected_hash: expectedHash, encoding: "utf-8", bom: false });
  return { hash: r.hash };
}

async function writeLessons(fs: LoopFs, text: string, expectedHash: string | null): Promise<void> {
  const opts = { expected_hash: expectedHash, encoding: "utf-8" as const, bom: false };
  try {
    await fs.write(LESSONS_FILE, text, opts);
  } catch (e) {
    // The first lesson: make the folder (its parent system/ holds loop.json, so it exists), then write again.
    if (expectedHash !== null || !fs.create) throw e;
    await fs.create(SELF_IMPROVEMENT_DIR, "dir").catch(() => undefined);
    await fs.write(LESSONS_FILE, text, opts);
  }
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
