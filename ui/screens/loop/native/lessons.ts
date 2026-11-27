// Loop step lessons (a stage's `promptAddendum`) live in `<project>/system/self-improvement/lessons.json`, the one
// home of learned knowledge. In memory they
// stay on the stage as `promptAddendum`, so prompt building, accept/revert and the editor are unchanged; store.ts puts
// them there on load and takes them out of loop.json on save. Pure.
import type { LoopProjectStore } from "./model.ts";

export const LESSONS_FILE = "system/self-improvement/lessons.json";
export const SELF_IMPROVEMENT_DIR = "system/self-improvement";
export const MAX_LESSON_CHARS = 2000;
const MANIFEST_FILE = "system/self-improvement/manifest.json";

/**
 * Creates system/self-improvement/ with a manifest at once (`root: null`: the core fills in this project's real path
 * on its next read). A folder without a manifest is treated as of unknown origin and reviewed, so every creator writes
 * one. Both steps tolerate "already there".
 */
// Set by the open Loop page (NativeLoopScreen): POST /kb/agent/self-improvement/claim for the open project. Called
// before the desktop writes the folder (so the core's shell guard never undoes the app's own write) and after it
// creates it (so the new manifest gets this project's real root at once). Best effort: unset or failing, writes go on.
let learnedWriteHook: (() => Promise<unknown>) | null = null;
export function setLearnedWriteHook(hook: (() => Promise<unknown>) | null): void { learnedWriteHook = hook; }
export async function beforeLearnedWrite(): Promise<void> {
  try { await learnedWriteHook?.(); } catch { /* best effort */ }
}

export async function createSelfImprovementFolder(fs: { create?: (path: string, kind: "file" | "dir") => Promise<string>; write: (path: string, text: string, opts: { expected_hash: string | null; encoding: "utf-8"; bom: boolean }) => Promise<unknown> }): Promise<void> {
  if (!fs.create) return;
  await fs.create(SELF_IMPROVEMENT_DIR, "dir").catch(() => undefined);
  await fs.write(MANIFEST_FILE, `${JSON.stringify({ format: 1, root: null, createdBy: "desktop" }, null, 2)}\n`, { expected_hash: null, encoding: "utf-8", bom: false }).catch(() => undefined);
  await beforeLearnedWrite(); // the core claims it now, with this project's real root
}
const MAX_ENTRIES = 2000;
const ID_MAX = 200;

/** One lesson. `loopKey`/`stageKey` are the shared default keys, so another repo can match the same step on import. */
export interface LessonEntry {
  loopId: string;
  loopKey: string | null;
  stageId: string;
  stageKey: string | null;
  text: string;
  updatedAt: string;
  /** Where it came from when not learned here (`imported:<project name>`). */
  origin?: string;
}

/** Tabs become a space; other control characters (except newline) and bidi/zero-width characters are removed; then trim. */
export function cleanLesson(text: string): string {
  return text
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, "")
    .trim();
}

/** Cleaned and capped, so a hand-typed lesson gets the same rules as an accepted one. */
export const boundedLesson = (text: string): string => cleanLesson(text).slice(0, MAX_LESSON_CHARS).trim();

const str = (v: unknown, max = ID_MAX): string | null => (typeof v === "string" && v !== "" && v.length <= max ? v : null);

/** The file's entries, or null when it is not a lessons file (corrupt: never overwritten silently). */
export function decodeLessons(raw: unknown): LessonEntry[] | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.format !== 1 || !Array.isArray(o.lessons)) return null;
  const out: LessonEntry[] = [];
  for (const item of o.lessons.slice(0, MAX_ENTRIES)) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const loopId = str(e.loopId);
    const stageId = str(e.stageId);
    const text = typeof e.text === "string" ? boundedLesson(e.text) : "";
    if (!loopId || !stageId || text === "") continue;
    out.push({
      loopId, loopKey: str(e.loopKey), stageId, stageKey: str(e.stageKey), text,
      updatedAt: str(e.updatedAt, 40) ?? "",
      ...(str(e.origin) ? { origin: str(e.origin) as string } : {}),
    });
  }
  return out;
}

export function encodeLessons(entries: readonly LessonEntry[]): string {
  return `${JSON.stringify({ format: 1, lessons: entries }, null, 2)}\n`;
}

const sameStage = (e: LessonEntry, loopId: string, stageId: string) => e.loopId === loopId && e.stageId === stageId;

/**
 * Puts each lesson on its stage. A stage with no entry keeps what loop.json carried (a file from before the move);
 * an entry wins over loop.json. Returns whether loop.json still held a lesson the file lacks (it needs moving).
 */
export function overlayLessons(store: LoopProjectStore, entries: readonly LessonEntry[]): boolean {
  let needsMove = false;
  for (const loop of store.loops) {
    for (const stage of loop.config.stages) {
      const entry = entries.find((e) => sameStage(e, loop.id, stage.id));
      if (entry) { stage.promptAddendum = entry.text; continue; }
      const carried = typeof stage.promptAddendum === "string" ? boundedLesson(stage.promptAddendum) : "";
      if (carried === "") { delete stage.promptAddendum; continue; }
      stage.promptAddendum = carried;
      needsMove = true;
    }
  }
  return needsMove;
}

/**
 * The file's entries after saving `store`: every loop in the store contributes its stages' lessons (cleaned and
 * capped); entries of loops the store does not hold are kept (an imported or not-yet-adopted lesson is never dropped
 * by an unrelated save). An unchanged lesson keeps its date.
 */
export function lessonsOf(store: LoopProjectStore, previous: readonly LessonEntry[], now: string): LessonEntry[] {
  const loopIds = new Set(store.loops.map((l) => l.id));
  const out: LessonEntry[] = previous.filter((e) => !loopIds.has(e.loopId));
  for (const loop of store.loops) {
    for (const stage of loop.config.stages) {
      const text = typeof stage.promptAddendum === "string" ? boundedLesson(stage.promptAddendum) : "";
      if (text === "") continue;
      const before = previous.find((e) => sameStage(e, loop.id, stage.id));
      out.push({
        loopId: loop.id, loopKey: loop.defaultKey ?? null, stageId: stage.id, stageKey: stage.defaultKey ?? null, text,
        updatedAt: before && before.text === text ? before.updatedAt : now,
        ...(before?.origin ? { origin: before.origin } : {}),
      });
    }
  }
  return out;
}

/** A copy of `store` with every lesson taken out, for loop.json. */
export function withoutLessons(store: LoopProjectStore): LoopProjectStore {
  const copy = structuredClone(store);
  for (const loop of copy.loops) for (const stage of loop.config.stages) delete stage.promptAddendum;
  return copy;
}
