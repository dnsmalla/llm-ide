#!/usr/bin/env node
// Conformance gate for schema/tasks (task registry, generated copies, prompts, templates).
//
//   node scripts/conformance-tasks.mjs          check
//   node scripts/conformance-tasks.mjs --sync   regenerate the copies, then check
//
// Checks: generated copies are current; ids/aliases are unique; runner rules; prompt files exist and no
// prompt text is duplicated; bus kinds/args exist; feature keys exist; template stage refs exist; no
// template stage still runs the removed Mac app. This is part of make contract-gates.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, OUTPUTS, PROMPTS_DIR, promptHash, renderAll, ROOT } from './gen-task-registry.mjs';
import { TASK_CLASS } from '../extension/agents/task-classes.mjs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const problems = [];
const bad = (message) => problems.push(message);

if (process.argv.includes('--sync')) {
  execFileSync(process.execPath, [join(ROOT, 'scripts/gen-task-registry.mjs')], { stdio: 'inherit' });
}

const registry = readJson(join(ROOT, 'schema/tasks/registry.json'));
const templates = readJson(join(ROOT, 'schema/tasks/templates.json'));
const bus = readJson(join(ROOT, 'schema/bus/registry.json'));
const featureText = readFileSync(join(ROOT, 'ui/screens/shell/features.ts'), 'utf8');
const featureKeys = new Set([...featureText.matchAll(/id:\s*"([a-z_]+)"/g)].map((m) => m[1]));

const GROUPS = new Set(['Pipeline', 'Review', 'Automation', 'Maintenance', 'Factory', 'Loop']);
const STATUSES = new Set(['available', 'unported', 'retired', 'alias']);
const RUNNERS = new Set(['agent', 'shell', 'core-route', 'desktop-action']);
const INPUTS = new Set(['repo', 'project', 'notes', 'issues', 'doc', 'none']);
const OUTPUTS_KIND = new Set(['text', 'file', 'fault-report', 'issue', 'pr', 'run-record', 'none']);
const PERSIST = new Set(['log', 'run-record', 'note', 'tracker', 'file', 'none']);
const SCHEDULE_BACKENDS = new Set(['none', 'desktop', 'bus']);
const SCOPES = new Set(['project', 'app']);
const ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

if (!registry || typeof registry !== 'object' || !Array.isArray(registry.tasks)) bad('registry.json must hold { version, tasks[] }');
if (!templates || typeof templates !== 'object' || !Array.isArray(templates.templates)) bad('templates.json must hold { version, templates[] }');

const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
const ids = new Set();
const aliases = new Set();
for (const task of tasks) {
  const at = `task ${task?.id ?? '<missing id>'}`;
  if (!task || typeof task !== 'object') { bad('a task is not an object'); continue; }
  if (typeof task.id !== 'string' || !ID.test(task.id)) bad(`${at}: id must be dotted lower-case`);
  else if (ids.has(task.id)) bad(`${at}: duplicate id`);
  else ids.add(task.id);
  if (typeof task.label !== 'string' || !task.label.trim()) bad(`${at}: label is required`);
  if (!GROUPS.has(task.group)) bad(`${at}: unknown group ${task.group}`);
  if (typeof task.description !== 'string') bad(`${at}: description must be a string`);
  if (!Array.isArray(task.aliases)) bad(`${at}: aliases must be an array`);
  for (const alias of Array.isArray(task.aliases) ? task.aliases : []) {
    if (typeof alias !== 'string' || !alias) bad(`${at}: an alias must be a non-empty string`);
    else if (aliases.has(alias) || ids.has(alias)) bad(`${at}: alias ${alias} is duplicated or shadows an id`);
    else aliases.add(alias);
  }
  const status = task.availability?.status;
  if (!STATUSES.has(status)) bad(`${at}: unknown availability ${status}`);
  if (status !== 'available' && (typeof task.availability?.reason !== 'string' || !task.availability.reason.trim())) {
    bad(`${at}: a ${status} task must say why`);
  }
  if (status === 'available' && task.availability?.reason !== null) bad(`${at}: an available task must have reason null`);
  if ((status === 'retired' || status === 'alias') && task.runner !== null) bad(`${at}: a ${status} task must have runner:null`);
  if (status === 'alias' && (typeof task.aliasOf !== 'string' || !task.aliasOf)) bad(`${at}: an alias task needs aliasOf`);
  if (task.aliasOf !== undefined && !ids.has(task.aliasOf) && !tasks.some((t) => t?.id === task.aliasOf)) bad(`${at}: aliasOf target ${task.aliasOf} is missing`);

  if (task.runner !== null) {
    const runner = task.runner;
    if (!runner || typeof runner !== 'object' || !RUNNERS.has(runner.kind)) bad(`${at}: unknown runner`);
    else {
      if (runner.kind === 'agent') {
        if (typeof runner.prompt !== 'string' || !/^prompts\/[\w.-]+\.md$/.test(runner.prompt)) bad(`${at}: an agent runner needs prompts/<id>.md`);
        if (runner.route !== undefined || runner.action !== undefined) bad(`${at}: an agent runner cannot carry route/action`);
      }
      if (runner.kind === 'shell' && (typeof runner.stage?.kind !== 'string' || !runner.stage.kind)) bad(`${at}: a shell runner needs stage.kind`);
      if (runner.kind === 'shell' && runner.prompt !== undefined) bad(`${at}: a shell runner has no prompt`);
      if (runner.kind === 'core-route' && (typeof runner.route !== 'string' || !runner.route)) bad(`${at}: a core-route runner needs a route id`);
      if (runner.kind === 'core-route' && runner.prompt !== undefined) bad(`${at}: a core-route runner has no prompt`);
      if (runner.kind === 'desktop-action' && (typeof runner.action !== 'string' || !runner.action)) bad(`${at}: a desktop-action runner needs an action`);
      if (runner.kind === 'desktop-action' && runner.prompt !== undefined) bad(`${at}: a desktop-action runner has no prompt`);
      if (runner.timeoutSeconds !== undefined && (!Number.isInteger(runner.timeoutSeconds) || runner.timeoutSeconds < 1)) bad(`${at}: timeoutSeconds must be a positive integer`);
    }
  }

  if (!INPUTS.has(task.input?.kind) || typeof task.input?.required !== 'boolean') bad(`${at}: invalid input`);
  if (!OUTPUTS_KIND.has(task.output?.kind) || !PERSIST.has(task.output?.persist) || typeof task.output?.revertWrites !== 'boolean') bad(`${at}: invalid output`);
  if (!SCHEDULE_BACKENDS.has(task.schedule?.backend) || typeof task.schedule?.schedulable !== 'boolean') bad(`${at}: invalid schedule`);
  if (task.schedule?.defaultCron !== null && typeof task.schedule?.defaultCron !== 'string') bad(`${at}: defaultCron must be a string or null`);
  if (!SCOPES.has(task.scope)) bad(`${at}: invalid scope`);
  for (const key of ['readOnly', 'requiresRepo', 'requiresLocalHost']) if (typeof task[key] !== 'boolean') bad(`${at}: ${key} must be boolean`);
  if (!Array.isArray(task.features) || task.features.some((f) => typeof f !== 'string' || !featureKeys.has(f))) bad(`${at}: unknown feature key`);
  if (!Number.isInteger(task.revision) || task.revision < 1) bad(`${at}: revision must be a positive integer`);

  if (task.runner?.kind === 'core-route' && (typeof task.runner.route !== 'string' || !Object.hasOwn(TASK_CLASS, task.runner.route))) {
    bad(`${at}: core-route ${task.runner.route ?? '(missing)'} has no TASK_CLASS entry`);
  }
  if (typeof task.runner?.busKind === 'string') {
    if (!Object.hasOwn(bus.kinds ?? {}, task.runner.busKind)) bad(`${at}: busKind ${task.runner.busKind} does not exist`);
    else {
      const props = bus.kinds[task.runner.busKind].args?.properties ?? {};
      for (const key of Object.keys(task.runner.busArgs ?? {})) {
        if (!Object.hasOwn(props, key)) bad(`${at}: busArgs.${key} is not in ${task.runner.busKind}.args`);
      }
    }
  }
}

// Prompt files: only *.md, every agent prompt exists, and no two files have the same text.
const promptNames = readdirSync(PROMPTS_DIR).filter((n) => n.endsWith('.md')).sort();
const hashes = new Map();
for (const name of promptNames) {
  const path = join(PROMPTS_DIR, name);
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) bad(`prompt ${name} is empty`);
  const hash = promptHash(text);
  if (hashes.has(hash)) bad(`prompt ${name} duplicates ${hashes.get(hash)}`);
  else hashes.set(hash, name);
}
for (const task of tasks) {
  if (task.runner?.kind !== 'agent') continue;
  const rel = task.runner.prompt;
  if (typeof rel !== 'string' || !promptNames.includes(rel.slice('prompts/'.length))) bad(`task ${task.id}: prompt ${rel} is missing`);
}

// Templates: every stage taskId exists; no removed Mac app command.
for (const template of Array.isArray(templates?.templates) ? templates.templates : []) {
  const at = `template ${template?.id ?? '<missing id>'}`;
  if (!template || typeof template !== 'object' || typeof template.id !== 'string' || !template.id) { bad('a template has no id'); continue; }
  if (typeof template.name !== 'string' || !template.name.trim()) bad(`${at}: name is required`);
  if (!['starter', 'recipe'].includes(template.kind)) bad(`${at}: kind must be starter or recipe`);
  if (!Array.isArray(template.stages)) bad(`${at}: stages must be an array`);
  for (const stage of Array.isArray(template.stages) ? template.stages : []) {
    if (typeof stage?.taskId === 'string' && !ids.has(stage.taskId)) bad(`${at}: stage task ${stage.taskId} does not exist`);
    if (typeof stage?.command === 'string' && /\bcd\s+mac\b/.test(stage.command)) bad(`${at}: stage command still runs the removed Mac app`);
  }
}

// Generated copies are current.
try {
  const rendered = renderAll(buildRegistry());
  for (const [path, text] of Object.entries(rendered)) {
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch { /* missing is stale */ }
    if (current === null || current.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) bad(`generated copy is stale: ${path} (run: node scripts/gen-task-registry.mjs)`);
  }
} catch (err) {
  bad(`could not build the registry: ${err instanceof Error ? err.message : String(err)}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`conformance-tasks: ${problem}`);
  console.error(`conformance-tasks: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`conformance-tasks: ok (${tasks.length} task(s), ${promptNames.length} prompt(s), ${(templates.templates ?? []).length} template(s))`);
