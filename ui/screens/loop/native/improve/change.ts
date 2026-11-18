// The code-level gate for loop improvements: decides which AI-proposed changes are allowed and applies them.
// Pure (no I/O). Deny-by-default: the loop must never be able to weaken its own checks (spec anti-goal A1).
import type { LoopDefinition, LoopStage } from "../model.ts";
import { isFactoryLoop } from "../factory.ts";

export type StageField = "timeoutSeconds" | "runOnce" | "reviewAfter" | "enabled";
export type ConfigField = "maxIterations" | "maxRepairsPerStage" | "stageDelaySeconds" | "refactorBatchesPerRun" | "maxCostUsd" | "wallClockBudgetSeconds";
export type ImprovementChange =
  | { op: "setPromptAddendum"; stageId: string; stageKey: string | null; stageName: string; before: string | null; after: string }
  | { op: "setStageField"; stageId: string; stageKey: string | null; stageName: string; field: StageField; before: number | boolean | null; after: number | boolean | null }
  | { op: "moveStage"; stageId: string; stageKey: string | null; stageName: string; beforeIndex: number; afterIndex: number }
  | { op: "setConfig"; field: ConfigField; before: number | null; after: number | null };

type Verdict = { ok: true; change: ImprovementChange } | { ok: false; reason: string };

const MAX_ADDENDUM_CHARS = 2000;
const STAGE_FIELDS: readonly StageField[] = ["timeoutSeconds", "runOnce", "reviewAfter", "enabled"];
const CONFIG_FIELDS: readonly ConfigField[] = ["maxIterations", "maxRepairsPerStage", "stageDelaySeconds", "refactorBatchesPerRun", "maxCostUsd", "wallClockBudgetSeconds"];
/** Inclusive integer bounds of each config field; maxCostUsd is checked separately (no upper bound but `before`). */
const CONFIG_RANGES: Readonly<Record<Exclude<ConfigField, "maxCostUsd">, readonly [number, number]>> = {
  maxIterations: [1, 50], maxRepairsPerStage: [1, 10], stageDelaySeconds: [0, 60], refactorBatchesPerRun: [1, 20], wallClockBudgetSeconds: [300, 14400],
};
/** Skills whose position is a safety property (they gate the run), so they never move and nothing moves past them. */
const PINNED_SKILLS: ReadonlySet<string> = new Set(["skills/factory-review", "skills/factory-intake"]);
const FACTORY_OWNED = "the Factory template owns this setting";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const no = (reason: string): Verdict => ({ ok: false, reason });
const sorted = (loop: LoopDefinition): LoopStage[] => [...loop.config.stages].sort((a, b) => a.order - b.order);

/** Strip control characters except newline, then trim. */
function cleanAddendum(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
}

/** A skill stage that is not one of the pinned gate skills. */
function isMovable(stage: LoopStage): boolean {
  return stage.kind === "skill" && !(stage.skillId !== null && PINNED_SKILLS.has(stage.skillId));
}

/** The stage a change targets: by id, else by the shared default key. */
export function resolveStage(change: ImprovementChange, loop: LoopDefinition): LoopStage | null {
  if (change.op === "setConfig") return null;
  const stages = loop.config.stages;
  const byId = stages.find((s) => s.id === change.stageId);
  if (byId) return byId;
  if (change.stageKey !== null) return stages.find((s) => s.defaultKey === change.stageKey) ?? null;
  return null;
}

function stageHead(raw: Record<string, unknown>): { stageId: string; stageKey: string | null; stageName: string } | null {
  if (typeof raw.stageId !== "string" || typeof raw.stageName !== "string") return null;
  if (raw.stageKey !== null && typeof raw.stageKey !== "string") return null;
  return { stageId: raw.stageId, stageKey: raw.stageKey, stageName: raw.stageName };
}

function checkStageField(head: ReturnType<typeof stageHead> & object, raw: Record<string, unknown>, stage: LoopStage, strict: boolean): Verdict {
  const field = raw.field as StageField;
  if (!STAGE_FIELDS.includes(field)) return no(`field ${String(raw.field)} cannot be changed`);
  const { before, after } = raw;
  const change = { op: "setStageField", ...head, field, before, after } as ImprovementChange;
  if (field === "timeoutSeconds") {
    if (!isNumOrNull(before) || !isNumOrNull(after)) return no("timeoutSeconds must be a number");
    if (strict && (!isInt(after) || after < 60 || after > 14400)) return no("timeoutSeconds must be a whole number from 60 to 14400");
    return { ok: true, change };
  }
  if ((before !== null && typeof before !== "boolean") || (after !== null && typeof after !== "boolean")) return no(`${field} must be a boolean`);
  if (!strict) return { ok: true, change };
  if (field === "enabled") {
    if (typeof after !== "boolean") return no("enabled must be true or false");
    if (after === false && stage.severity !== "advisory") return no("only an advisory step can be turned off");
    return { ok: true, change };
  }
  if (after !== true) return no(`${field} can only be turned on`);
  return { ok: true, change };
}

function checkConfig(raw: Record<string, unknown>, strict: boolean): Verdict {
  const field = raw.field as ConfigField;
  if (!CONFIG_FIELDS.includes(field)) return no(`setting ${String(raw.field)} cannot be changed`);
  const { before, after } = raw;
  if (!isNumOrNull(before) || !isNumOrNull(after)) return no(`${field} must be a number`);
  const change: ImprovementChange = { op: "setConfig", field, before, after };
  if (!strict) return { ok: true, change };
  if (after === null) return no(`${field} needs a value`);
  if (field === "maxCostUsd") {
    if (!(after > 0)) return no("maxCostUsd must be above 0");
    if (before !== null && after > before) return no("maxCostUsd cannot be raised");
    return { ok: true, change };
  }
  const [min, max] = CONFIG_RANGES[field];
  if (!isInt(after) || after < min || after > max) return no(`${field} must be a whole number from ${min} to ${max}`);
  return { ok: true, change };
}

function checkMove(head: ReturnType<typeof stageHead> & object, raw: Record<string, unknown>, loop: LoopDefinition, stage: LoopStage, strict: boolean): Verdict {
  const { beforeIndex, afterIndex } = raw;
  const list = sorted(loop);
  if (!isInt(beforeIndex) || !isInt(afterIndex)) return no("move positions must be whole numbers");
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= list.length || afterIndex >= list.length) return no("move position is out of range");
  const change: ImprovementChange = { op: "moveStage", ...head, beforeIndex, afterIndex };
  if (!strict) return { ok: true, change };
  if (beforeIndex === afterIndex) return no("the step would not move");
  if (list[beforeIndex] !== stage) return no("the step is not at the stated position");
  const lo = Math.min(beforeIndex, afterIndex);
  const hi = Math.max(beforeIndex, afterIndex);
  for (let i = lo; i <= hi; i++) if (!isMovable(list[i])) return no(`step "${list[i].name}" cannot be moved or passed`);
  return { ok: true, change };
}

/** The shared check. `strict` adds the direction and range rules; a Revert inverts a strict change, so it skips them. */
function check(raw: unknown, loop: LoopDefinition, strict: boolean): Verdict {
  if (!isObj(raw)) return no("change is not an object");
  const op = raw.op;
  if (op !== "setPromptAddendum" && op !== "setStageField" && op !== "moveStage" && op !== "setConfig") return no(`operation ${String(op)} is not allowed`);
  if (isFactoryLoop(loop)) {
    const allowed = op === "setPromptAddendum" || (op === "setConfig" && (raw.field === "maxRepairsPerStage" || raw.field === "stageDelaySeconds"));
    if (!allowed) return no(FACTORY_OWNED);
  }
  if (op === "setConfig") return checkConfig(raw, strict);
  const head = stageHead(raw);
  if (!head) return no("the step is not identified");
  const stage = resolveStage({ op: "moveStage", ...head, beforeIndex: 0, afterIndex: 0 }, loop);
  if (!stage) return no("the loop has no such step");
  if (op === "setStageField") return checkStageField(head, raw, stage, strict);
  if (op === "moveStage") return checkMove(head, raw, loop, stage, strict);
  const { before, after } = raw;
  if ((before !== null && typeof before !== "string") || typeof after !== "string") return no("the addendum must be text");
  const text = cleanAddendum(after);
  if (strict && (text === "" || text.length > MAX_ADDENDUM_CHARS)) return no(`the addendum must be 1 to ${MAX_ADDENDUM_CHARS} characters`);
  return { ok: true, change: { op: "setPromptAddendum", ...head, before, after: text } };
}

/** Decide whether a proposed change is allowed; anything not explicitly allowed is refused. Returns a normalized copy. */
export function validateChange(change: unknown, loop: LoopDefinition): Verdict {
  return check(change, loop, true);
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/** True when the loop no longer holds the value the change was proposed against (or the target is gone). */
export function isStale(change: ImprovementChange, loop: LoopDefinition): boolean {
  if (change.op === "setConfig") return !same(loop.config[change.field], change.before);
  const stage = resolveStage(change, loop);
  if (!stage) return true;
  if (change.op === "moveStage") return sorted(loop).indexOf(stage) !== change.beforeIndex;
  if (change.op === "setPromptAddendum") return !same(stage.promptAddendum === "" ? null : stage.promptAddendum, change.before);
  return !same(stage[change.field], change.before);
}

/**
 * Apply a change to a copy of the loop. Throws on a stale change, a missing step or a malformed change. It does not
 * re-check direction (a Revert loosens on purpose), so callers MUST gate proposals through validateChange first.
 */
export function applyChange(loop: LoopDefinition, change: ImprovementChange): LoopDefinition {
  const verdict = check(change, loop, false);
  if (!verdict.ok) throw new Error(verdict.reason);
  const safe = verdict.change;
  if (isStale(safe, loop)) throw new Error("This suggestion is out of date");
  const next = structuredClone(loop);
  if (safe.op === "setConfig") {
    (next.config as unknown as Record<string, number | null>)[safe.field] = safe.after;
    return next;
  }
  const stage = resolveStage(safe, next) as LoopStage;
  if (safe.op === "setPromptAddendum") {
    if (safe.after === "") delete stage.promptAddendum;
    else stage.promptAddendum = safe.after;
  } else if (safe.op === "setStageField") {
    if (safe.field === "reviewAfter" && safe.after === null) delete stage.reviewAfter;
    else (stage as unknown as Record<string, unknown>)[safe.field] = safe.after;
  } else {
    const list = sorted(next);
    list.splice(list.indexOf(stage), 1);
    list.splice(safe.afterIndex, 0, stage);
    list.forEach((s, index) => { s.order = index; });
    next.config.stages = list;
  }
  return next;
}

/** The change that undoes `change` (for Revert). */
export function invertChange(change: ImprovementChange): ImprovementChange {
  if (change.op === "setPromptAddendum") return { ...change, before: change.after === "" ? null : change.after, after: change.before ?? "" };
  if (change.op === "moveStage") return { ...change, beforeIndex: change.afterIndex, afterIndex: change.beforeIndex };
  return { ...change, before: change.after, after: change.before } as ImprovementChange;
}

/** `projectOnly` when the target has no shared default key, so it must not be offered to other loops. */
export function shareableScope(change: ImprovementChange, loop: LoopDefinition): "general" | "projectOnly" {
  if (change.op === "setConfig") return loop.defaultKey === null ? "projectOnly" : "general";
  const key = resolveStage(change, loop)?.defaultKey ?? change.stageKey;
  return key === null ? "projectOnly" : "general";
}

