// Loop lessons and Loop changes another project brought (plan 2026-11-19, phase 5). The core lists the inbox (and
// moves a folder copied from another project into it before anything reads it); this module reads the two Loop
// files of each source through the root-confined host fs, matches each item to a local loop and stage by the shared
// default keys, and adopts or dismisses it. Adopt applies through the same strict rules and stale check as an offer
// (change.ts); nothing from the inbox reaches a prompt or the loop file before that. Both remove the item from the
// inbox file.
import type { LoopDefinition, LoopProjectStore } from "../model.ts";
import { boundedLesson, decodeLessons, encodeLessons, SELF_IMPROVEMENT_DIR, type LessonEntry } from "../lessons.ts";
import { saveLoops, loadLoops, type LoopFs } from "../store.ts";
import type { CoreFetch } from "../stage-exec.ts";
import { applyChange, type ImprovementChange } from "./change.ts";
import { appendChangeLines, changeLine, parseChangeLog, type ChangeLine } from "./changes-log.ts";

const SOURCE_RE = /^[A-Za-z0-9._-]{1,100}$/;
export interface InboxLoopItem {
  source: string;
  projectName: string;
  kind: "lesson" | "change";
  /** Stable within its file: the lesson's loop+stage ids, or the change line's id. */
  key: string;
  loopId: string | null;
  stageName: string | null;
  text: string;
  lesson?: LessonEntry;
  line?: ChangeLine;
}

const dir = (source: string) => `${SELF_IMPROVEMENT_DIR}/inbox/${source}`;
const codeOf = (e: unknown) => (typeof e === "object" && e !== null ? String((e as { code?: unknown }).code ?? "") : "");

async function readOptional(fs: LoopFs, path: string): Promise<{ text: string; hash: string } | null> {
  try {
    const r = await fs.read(path, 4_000_000);
    return r.status === "ok" && r.text !== null && r.hash !== null ? { text: r.text, hash: r.hash } : null;
  } catch (e) {
    if (codeOf(e) === "missing" || codeOf(e) === "not_found") return null;
    throw e;
  }
}

/** The local loop for an item: same template key; for a stage-level item the loop must also have the stage key. */
export function localLoopFor(store: LoopProjectStore, loopKey: string | null, stageKey: string | null): LoopDefinition | null {
  if (!loopKey && !stageKey) return null;
  return store.loops.find((l) => (loopKey === null || l.defaultKey === loopKey) && (stageKey === null || l.config.stages.some((s) => s.defaultKey === stageKey))) ?? null;
}

/** Inbox sources from the core (it tidies the folder first); an older core or an unregistered folder lists none. */
export async function inboxSources(core: CoreFetch, projectRoot: string): Promise<{ name: string; projectName: string }[]> {
  try {
    const r = await core.request<{ sources?: unknown }>(`/kb/agent/self-improvement/inbox?${new URLSearchParams({ workspaceRoot: projectRoot }).toString()}`);
    if (!Array.isArray(r?.sources)) return [];
    return r.sources.flatMap((s) => (typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string" && SOURCE_RE.test((s as { name: string }).name)
      ? [{ name: (s as { name: string }).name, projectName: String((s as { projectName?: unknown }).projectName ?? (s as { name: string }).name).slice(0, 100) }] : []));
  } catch { return []; }
}

/** Every waiting lesson and accepted change, matched to this project's loops where a match exists. */
export async function readLoopInbox(fs: LoopFs, store: LoopProjectStore, sources: readonly { name: string; projectName: string }[]): Promise<InboxLoopItem[]> {
  const out: InboxLoopItem[] = [];
  for (const src of sources) {
    const lessonsFile = await readOptional(fs, `${dir(src.name)}/lessons.json`).catch(() => null);
    let lessons: LessonEntry[] = [];
    try { lessons = lessonsFile ? decodeLessons(JSON.parse(lessonsFile.text)) ?? [] : []; } catch { /* unreadable: nothing listed */ }
    for (const l of lessons) {
      const loop = localLoopFor(store, l.loopKey, l.stageKey);
      const stage = loop?.config.stages.find((s) => s.defaultKey === l.stageKey) ?? null;
      out.push({ source: src.name, projectName: src.projectName, kind: "lesson", key: `${l.loopId}/${l.stageId}`, loopId: loop?.id ?? null, stageName: stage?.name ?? null, text: l.text, lesson: l });
    }
    const changesFile = await readOptional(fs, `${dir(src.name)}/changes.jsonl`).catch(() => null);
    const lines = changesFile ? parseChangeLog(changesFile.text) : [];
    // Only changes that were still in force there: the newest decision per id is an accept or adopt.
    const last = new Map<string, ChangeLine>();
    for (const l of lines) if (l.action !== "outcome") last.set(l.id, l);
    for (const l of last.values()) {
      if ((l.action !== "accept" && l.action !== "adopt") || !l.change || l.change.op === "setPromptAddendum") continue;
      const loop = localLoopFor(store, l.loopKey, l.stageKey);
      const verdict = lines.filter((x) => x.id === l.id && x.action === "outcome").pop()?.verdict;
      out.push({
        source: src.name, projectName: src.projectName, kind: "change", key: l.id, loopId: loop?.id ?? null,
        stageName: "stageName" in l.change ? l.change.stageName : null,
        text: `${describe(l.change)}${l.rationale ? ` — ${l.rationale}` : ""}${verdict ? ` (there: ${verdict})` : ""}`, line: l,
      });
    }
  }
  return out;
}

function describe(c: ImprovementChange): string {
  if (c.op === "setConfig") return `${c.field}: ${c.before ?? "default"} → ${c.after ?? "default"}`;
  if (c.op === "setStageField") return `${c.stageName}: ${c.field} ${String(c.before)} → ${String(c.after)}`;
  if (c.op === "moveStage") return `move ${c.stageName} to position ${c.afterIndex + 1}`;
  return `${c.stageName}: lesson`;
}

/** Removes the item from its inbox file (hash-checked). */
async function removeFromInbox(fs: LoopFs, item: InboxLoopItem): Promise<void> {
  if (item.kind === "lesson") {
    const path = `${dir(item.source)}/lessons.json`;
    const cur = await readOptional(fs, path);
    if (!cur) return;
    const entries = decodeLessons(JSON.parse(cur.text)) ?? [];
    await fs.write(path, encodeLessons(entries.filter((e) => `${e.loopId}/${e.stageId}` !== item.key)), { expected_hash: cur.hash, encoding: "utf-8", bom: false });
    return;
  }
  const path = `${dir(item.source)}/changes.jsonl`;
  const cur = await readOptional(fs, path);
  if (!cur) return;
  const kept = cur.text.split("\n").filter((raw) => {
    if (raw.trim() === "") return false;
    try { return (JSON.parse(raw) as { id?: unknown }).id !== item.key; } catch { return true; }
  });
  await fs.write(path, kept.length ? `${kept.join("\n")}\n` : "", { expected_hash: cur.hash, encoding: "utf-8", bom: false });
}

export type InboxDeps = { fs: LoopFs; load: { store: LoopProjectStore; hash: string }; runningLoopIds: ReadonlySet<string>; isRunning?: () => boolean };

/**
 * Adopts one item into this project: a lesson onto the matched stage (cleaned and capped), a change through the strict
 * offer rules and stale check; the change is logged as an `adopt` with origin `imported:<project>`. Then it leaves the
 * inbox. Throws a plain reason when it cannot apply here (no matching step, stale, refused), leaving the inbox as is.
 */
export async function adoptInboxItem(deps: InboxDeps, item: InboxLoopItem): Promise<{ store: LoopProjectStore; hash: string }> {
  if (!item.loopId) throw new Error("This project has no matching loop or step");
  if (deps.runningLoopIds.has(item.loopId) || deps.isRunning?.()) throw new Error("Finish or stop the run first");
  const fresh = await loadLoops(deps.fs);
  const load = fresh.kind === "ok" ? { store: fresh.store, hash: fresh.hash } : deps.load;
  const store = structuredClone(load.store);
  const loop = store.loops.find((l) => l.id === item.loopId);
  if (!loop) throw new Error("This project has no matching loop or step");
  const origin = `imported:${item.projectName}`;
  if (item.kind === "lesson" && item.lesson) {
    const stage = loop.config.stages.find((s) => s.defaultKey === item.lesson?.stageKey);
    const text = boundedLesson(item.lesson.text);
    if (!stage || text === "") throw new Error("This project has no matching step");
    stage.promptAddendum = stage.promptAddendum ? `${stage.promptAddendum.trim()}\n${text}`.slice(0, 2000) : text;
    const saved = await saveLoops(deps.fs, store, load.hash);
    await removeFromInbox(deps.fs, item);
    return { store, hash: saved.hash };
  }
  const line = item.line;
  if (!line?.change) throw new Error("This change cannot be read");
  // Re-validated against THIS loop (full rules and stale check): its own `before` must match here, as for an offer.
  const next = applyChange(loop, line.change, { mode: "forward" });
  const nextStore = { ...store, loops: store.loops.map((l) => (l.id === loop.id ? next : l)) };
  const saved = await saveLoops(deps.fs, nextStore, load.hash);
  await appendChangeLines(deps.fs, [changeLine("adopt", {
    id: `${item.source}:${line.id}`, loopId: loop.id, stageKey: line.stageKey, change: line.change, rationale: line.rationale ?? "",
    evidence: { signalIds: [], excerpts: line.excerpts ?? [] }, origin,
  }, null, { scope: "project", loopKey: loop.defaultKey ?? null })]).catch(() => undefined);
  await removeFromInbox(deps.fs, item);
  return { store: nextStore, hash: saved.hash };
}

export async function dismissInboxItem(fs: LoopFs, item: InboxLoopItem): Promise<void> {
  await removeFromInbox(fs, item);
}
