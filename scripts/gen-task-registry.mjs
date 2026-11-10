#!/usr/bin/env node
// Generate the checked-in task catalog copies from schema/tasks.
//
//   node scripts/gen-task-registry.mjs           write the generated files
//   node scripts/gen-task-registry.mjs --check   fail when a copy is stale
//
// The data is schema/tasks/registry.json + templates.json + prompts/*.md. The output is deterministic:
// tasks and keys are sorted, JSON is pretty-printed, and the prompt module contains the prompt text.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_PATH = join(ROOT, 'schema/tasks/registry.json');
export const TEMPLATES_PATH = join(ROOT, 'schema/tasks/templates.json');
export const PROMPTS_DIR = join(ROOT, 'schema/tasks/prompts');

export const OUTPUTS = Object.freeze({
  uiRegistry: join(ROOT, 'ui/screens/tasks/registry.generated.ts'),
  uiPrompts: join(ROOT, 'ui/screens/tasks/prompts.generated.ts'),
  coreRegistry: join(ROOT, 'extension/core/task-registry.generated.mjs'),
  corePrompts: join(ROOT, 'extension/core/task-prompts.generated.mjs'),
  loopTemplates: join(ROOT, 'ui/screens/loop/native/templates.generated.ts'),
  loopDefaults: join(ROOT, 'ui/screens/loop/native/defaults.generated.ts'),
});

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
// A Windows checkout may hand back CRLF; a prompt is the same text on every platform.
const readPrompt = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const sortObject = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

/** JSON that is safe inside a JS/TS module (U+2028/U+2029 are line terminators in old parsers). */
export function safeJson(value) {
  return JSON.stringify(value, null, 2).split(String.fromCharCode(0x2028)).join('\u2028').split(String.fromCharCode(0x2029)).join('\u2029');
}

/** Read the registry, its prompts and its templates. Throws on a missing prompt or malformed file. */
export function buildRegistry() {
  const registry = readJson(REGISTRY_PATH);
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.tasks)) throw new Error('registry.json must hold { version, tasks[] }');

  const tasks = [...registry.tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const aliases = {};
  const prompts = {};
  const promptParts = {};
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string') throw new Error('every task needs a string id');
    for (const alias of Array.isArray(task.aliases) ? task.aliases : []) {
      if (typeof alias !== 'string' || alias === '') throw new Error(`task ${task.id}: aliases must be non-empty strings`);
      if (Object.hasOwn(aliases, alias)) throw new Error(`alias ${alias} is listed twice`);
      aliases[alias] = task.id;
    }
    if (task.runner?.kind === 'agent') {
      if (typeof task.runner.prompt !== 'string') throw new Error(`task ${task.id}: an agent runner needs a prompt path`);
      const path = join(ROOT, 'schema/tasks', task.runner.prompt);
      const focus = readPrompt(path);
      if (typeof task.runner.frame === 'string') {
        // A shared frame (the READ-ONLY preamble and output format) holds one {{focus}} slot; the task supplies the slot.
        const frame = readPrompt(join(ROOT, 'schema/tasks', task.runner.frame));
        if (frame.split('{{focus}}').length !== 2) throw new Error(`task ${task.id}: frame ${task.runner.frame} needs exactly one {{focus}} slot`);
        promptParts[task.id] = { frame, focus };
        prompts[task.id] = frame.replace('{{focus}}', () => focus);
      } else {
        prompts[task.id] = focus;
      }
    }
  }
  return Object.freeze({
    version: registry.version ?? 1,
    tasks,
    aliases: sortObject(aliases),
    prompts: sortObject(prompts),
    promptParts: sortObject(promptParts),
  });
}

// The defaults every built-in Loop stage and config carries (the fields the Loop model reads). A recipe in
// templates.json writes only what differs; the generator fills the rest, so the emitted objects are complete.
export const LOOP_STAGE_DEFAULTS = Object.freeze({
  taskId: null, kind: 'shellCommand', command: null, skillId: null, targetPath: null, outputPath: null, prompt: null,
  isDefault: false, enabled: true, defaultKey: null, severity: 'blocking', timeoutSeconds: null, detectedCommand: null,
  check: null, testOp: null, graphOp: null, allowsRepair: true, runOnce: false, defaultRevision: null,
  disabledByDetection: null, raw: null,
});
export const LOOP_CONFIG_DEFAULTS = Object.freeze({
  maxIterations: 10, consecutiveFailureStop: 3, wallClockBudgetSeconds: null, pauseTimeoutSeconds: 1800,
  maxRepairsPerStage: 3, repairModel: null, protectedPathPolicy: 'revert', writeSummaryNote: false,
  extraProtectedGlobs: [], useWorktreesForConcurrentRuns: false, alwaysUseWorktree: false, openMergeRequest: true,
  refactorBatchesPerRun: null, maxCostUsd: null,
});

/**
 * Read templates.json: `starters` are the Mac starter loops (DEFAULT_LOOP_SPECS, verbatim), `templates` are the
 * built-in recipes. A recipe either lists `stages` (sparse; defaults filled here) or names a starter with
 * `configFrom` (the starter's config, copied as written).
 */
export function buildLoopCatalog() {
  const doc = readJson(TEMPLATES_PATH);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.starters) || !Array.isArray(doc.templates)) {
    throw new Error('templates.json must hold { version, starters[], templates[] }');
  }
  const starters = doc.starters;
  const templates = doc.templates.map((t) => {
    if (!t || typeof t.id !== 'string' || !t.id) throw new Error('a template has no id');
    if (typeof t.name !== 'string' || !t.name) throw new Error(`template ${t.id}: name is required`);
    if (typeof t.summary !== 'string') throw new Error(`template ${t.id}: summary must be a string`);
    if (t.configFrom !== undefined) {
      const spec = starters.find((s) => s.defaultKey === t.configFrom);
      if (!spec) throw new Error(`template ${t.id}: configFrom ${t.configFrom} is not a starter`);
      return { id: t.id, name: t.name, summary: t.summary, config: structuredClone(spec.config) };
    }
    if (!Array.isArray(t.stages) || t.stages.length === 0) throw new Error(`template ${t.id}: stages must be a non-empty array`);
    if (t.config !== undefined && (typeof t.config !== 'object' || t.config === null || Array.isArray(t.config) || 'stages' in t.config)) {
      throw new Error(`template ${t.id}: config holds overrides only`);
    }
    const stages = t.stages.map((s, i) => ({ id: `${t.id}/${i}`, ...LOOP_STAGE_DEFAULTS, name: s.name ?? `Stage ${i + 1}`, ...s, order: i }));
    return { id: t.id, name: t.name, summary: t.summary, config: { ...LOOP_CONFIG_DEFAULTS, ...(t.config ?? {}), stages } };
  });
  const ids = templates.map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new Error('template ids must be unique');
  return Object.freeze({ starters, templates });
}

const HEADER = '// Generated by scripts/gen-task-registry.mjs from schema/tasks/registry.json — do not edit.\n';
const LOOP_HEADER = '// Generated by scripts/gen-task-registry.mjs from schema/tasks/templates.json — do not edit.\n';

export function renderUiRegistry(data) {
  return [
    HEADER,
    'import type { TaskDef } from "./types.ts";\n',
    '\n',
    `export const TASKS: readonly TaskDef[] = ${safeJson(data.tasks)};\n`,
    '\n',
    'export const TASK_BY_ID: Readonly<Record<string, TaskDef>> = Object.freeze(Object.fromEntries(TASKS.map((t) => [t.id, t])));\n',
    '\n',
    `export const ALIASES: Readonly<Record<string, string>> = Object.freeze(${safeJson(data.aliases)});\n`,
  ].join('');
}

export function renderUiPrompts(data) {
  return [
    HEADER,
    '\n',
    `export const PROMPTS: Readonly<Record<string, string>> = Object.freeze(${safeJson(data.prompts)});\n`,
    '\n',
    `export const PROMPT_PARTS: Readonly<Record<string, { frame: string; focus: string }>> = Object.freeze(${safeJson(data.promptParts)});\n`,
  ].join('');
}

export function renderCoreRegistry(data) {
  return [
    HEADER,
    '\n',
    `export const TASKS = Object.freeze(${safeJson(data.tasks)});\n`,
    '\n',
    'export const TASK_BY_ID = Object.freeze(Object.fromEntries(TASKS.map((t) => [t.id, t])));\n',
    '\n',
    `export const ALIASES = Object.freeze(${safeJson(data.aliases)});\n`,
  ].join('');
}

export function renderCorePrompts(data) {
  return [
    HEADER,
    '\n',
    `export const PROMPTS = Object.freeze(${safeJson(data.prompts)});\n`,
    '\n',
    `export const PROMPT_PARTS = Object.freeze(${safeJson(data.promptParts)});\n`,
  ].join('');
}

/** The Loop's built-in recipes (BUILT_IN_TEMPLATES). The Factory recipe is not here: factory.ts builds it. */
export function renderLoopTemplates(loop) {
  return [
    LOOP_HEADER,
    'import type { LoopTemplate } from "./templates.ts";\n',
    '\n',
    // A configFrom recipe carries a starter's sparse stages (as the Mac starters do), so the cast matches defaults.generated.ts.
    `export const BUILT_IN_TEMPLATES = ${safeJson(loop.templates)} as unknown as LoopTemplate[];\n`,
  ].join('');
}

/** The six Mac starter loops (DEFAULT_LOOP_SPECS), verbatim from templates.json. */
export function renderLoopDefaults(loop) {
  return [
    LOOP_HEADER,
    'import type { LoopDefinition } from "./model.ts";\n',
    '\n',
    `export const DEFAULT_LOOP_SPECS = ${safeJson(loop.starters)} as unknown as Array<Omit<LoopDefinition, "id" | "config"> & { config: LoopDefinition["config"] }>;\n`,
  ].join('');
}

/** SHA-256 of a prompt, used by the conformance gate to refuse two copies of one prompt. */
export function promptHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function renderAll(data = buildRegistry(), loop = buildLoopCatalog()) {
  return Object.freeze({
    [OUTPUTS.uiRegistry]: renderUiRegistry(data),
    [OUTPUTS.uiPrompts]: renderUiPrompts(data),
    [OUTPUTS.coreRegistry]: renderCoreRegistry(data),
    [OUTPUTS.corePrompts]: renderCorePrompts(data),
    [OUTPUTS.loopTemplates]: renderLoopTemplates(loop),
    [OUTPUTS.loopDefaults]: renderLoopDefaults(loop),
  });
}

function checkOrWrite(write) {
  const rendered = renderAll();
  const stale = [];
  for (const [path, text] of Object.entries(rendered)) {
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== null && current.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n')) continue;
    if (!write) { stale.push(relative(ROOT, path)); continue; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  if (stale.length > 0) {
    console.error(`gen-task-registry: stale generated file(s): ${stale.join(', ')} (run: node scripts/gen-task-registry.mjs)`);
    process.exit(1);
  }
  if (write) console.log('gen-task-registry: wrote the generated task catalog');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  checkOrWrite(!check);
}
