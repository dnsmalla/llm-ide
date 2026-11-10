// Built-in Loop stages follow the task registry while they are unedited (Task 14d). A stage is unedited when its prompt
// is the text its stored hash names, or, for a stage saved before hashes, when its prompt is one of the task's published
// hashes. The first edit detaches the stage: it keeps its own text from then on and is never relinked.
import { DEFAULT_LOOP_SPECS } from "./defaults.ts";
import type { LoopStage } from "./model.ts";
import { sha256Hex } from "../../chat/approvals/digest.ts";
import { TASK_BY_ID } from "../../tasks/registry.generated.ts";
import { PROMPTS } from "../../tasks/prompts.generated.ts";

/** What the registry gives a default stage: the task, its prompt text, its revision and every published prompt hash. */
export interface PromptSource { id: string; revision: number; text: string; knownPromptHashes: readonly string[] }

/** Default key -> registry task, for stages saved before `promptRef` existed (they carry only their default key). */
const REF_BY_KEY: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  DEFAULT_LOOP_SPECS.flatMap((spec) => spec.config.stages.flatMap((s) => (s.promptRef && s.defaultKey ? [[s.defaultKey, s.promptRef] as const] : []))),
));

type Linkable = Pick<LoopStage, "isDefault" | "defaultKey" | "defaultRevision" | "promptRef">;

/** The registry task a default stage follows, or null for a user stage and for a stage the user detached. */
export function promptRefOf(stage: Linkable): string | null {
  if (!stage.isDefault || stage.defaultRevision === null) return null;
  return stage.promptRef ?? (stage.defaultKey ? REF_BY_KEY[stage.defaultKey] ?? null : null);
}

/** The registry prompt a stage follows today, or null when it follows none. */
export function registrySource(stage: Linkable): PromptSource | null {
  const id = promptRefOf(stage);
  const task = id ? TASK_BY_ID[id] : undefined;
  if (!id || !task || task.runner?.kind !== "agent" || typeof PROMPTS[id] !== "string") return null;
  return { id, revision: task.revision, text: PROMPTS[id], knownPromptHashes: task.knownPromptHashes ?? [] };
}

/** True while the stage's prompt is the text it was saved with (its stored hash, or a published revision of the task). */
export function isUnedited(stage: Pick<LoopStage, "prompt" | "promptHash">, source: Pick<PromptSource, "knownPromptHashes">): boolean {
  const digest = sha256Hex(stage.prompt ?? "");
  return stage.promptHash ? stage.promptHash === digest : source.knownPromptHashes.includes(digest);
}

/** The stage moved to the source's revision when it is unedited and behind it; otherwise the same object. */
export function upgradeDefaultStage(stage: LoopStage, source: PromptSource): LoopStage {
  if (promptRefOf(stage) !== source.id) return stage;
  if ((stage.defaultRevision ?? 0) >= source.revision || !isUnedited(stage, source)) return stage;
  return { ...stage, promptRef: source.id, prompt: source.text, promptHash: sha256Hex(source.text), defaultRevision: source.revision };
}

/** The prompt a stage runs and shows: the registry text while it is unedited, else the stage's own text. */
export function stagePromptText(stage: LoopStage, source: PromptSource | null): string | null {
  return source && isUnedited(stage, source) ? source.text : stage.prompt;
}

/** What the stage editor shows for a stage's prompt, so the text on screen is the text that runs. */
export function shownStagePrompt(stage: LoopStage): string {
  return stagePromptText(stage, registrySource(stage)) ?? "";
}

/** The fields a first edit sets: the stage keeps its inline text and is no longer linked to the registry. */
export function detachedFields(): Pick<LoopStage, "promptRef" | "promptHash" | "defaultRevision"> {
  return { promptRef: null, promptHash: null, defaultRevision: null };
}
