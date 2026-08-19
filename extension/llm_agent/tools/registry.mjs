//
// Single source of truth for every "special function" the /code-assist
// agent loop can dispatch, engine-agnostic. Legacy (runtime/route.mjs) and
// v2 (sdk/tools.mjs) both derive their dispatch/mount tables from
// entries()/names() instead of hand-maintaining their own copy — see
// docs/superpowers/specs/2026-08-19-agent-tools-registry-design.md.
//
// Deliberately does NOT carry `description`/schema: those already live in
// llm_agent/global/<name>.md frontmatter (loaded once at boot into
// globalSkills — see skills/registry.mjs), and a third copy here would
// recreate the exact two-place-drift bug class this module exists to close.
// `execute(args, ctx)` is a thin reference to the existing handler; `ctx` is
// the same superset context object route.mjs already builds per request
// PLUS `loopCtx` (only `ask-internal`/`ask-subagent` read it, for `depth`).
//
// `kind` is a NEW safety axis, independent of the .md frontmatter's
// 'read'/'write' kind (which drives the unrelated client-side pendingTool
// flow in loop.mjs). Only 'act' entries carry a `gate(args) ->
// 'blocked'|'auto'|'prompt'`; entries with no meaningful safety tiering
// (task-create/task-update) get the constant `autoGate`.
import { askInternal } from '../runtime/handlers/ask-internal.mjs';
import { askSubagent } from '../runtime/handlers/ask-subagent.mjs';
import { handleWebSearch } from '../runtime/handlers/web-search.mjs';
import { handleFetchUrl } from '../runtime/handlers/fetch-url.mjs';
import { handleListFiles, handleReadFile } from '../runtime/handlers/repo-files.mjs';
import { handleFindCode } from '../runtime/handlers/find-code.mjs';
import { searchKb } from '../runtime/handlers/search-kb.mjs';
import { tasks } from '../runtime/handlers/session-tasks.mjs';
import { handleRunBash } from '../runtime/handlers/run-bash.mjs';
import { runBashGate, autoGate } from './gates.mjs';

const ENTRIES = [
  {
    name: 'ask-internal',
    kind: 'read',
    execute: (args, ctx) => askInternal(args, {
      agentContext: ctx.agentContext,
      runClaude: ctx.runClaude,
      kb: ctx.kb,
      userId: ctx.userId,
      depth: ctx.loopCtx?.depth ?? 1,
      internalSkills: { skills: ctx.userSkills, base: ctx.internalSkills?.base },
      model: ctx.internalModel,
    }),
  },
  {
    name: 'ask-subagent',
    kind: 'read',
    execute: (args, ctx) => askSubagent(args, {
      runClaude: ctx.runClaude,
      kb: ctx.kb,
      userId: ctx.userId,
      subagents: ctx.userSubagents,
      defaultModel: ctx.subagentModel,
      depth: ctx.loopCtx?.depth ?? 1,
      internalSkillsBase: ctx.internalSkills?.base,
    }),
  },
  { name: 'web-search', kind: 'read', execute: (args, ctx) => handleWebSearch(args, { userId: ctx.userId }) },
  { name: 'fetch-url', kind: 'read', execute: (args, ctx) => handleFetchUrl(args, { userId: ctx.userId }) },
  { name: 'list-files', kind: 'read', execute: (args, ctx) => handleListFiles(args, { roots: ctx.readableRoots }) },
  { name: 'read-file', kind: 'read', execute: (args, ctx) => handleReadFile(args, { roots: ctx.readableRoots }) },
  {
    name: 'find-code',
    kind: 'read',
    execute: (args, ctx) => handleFindCode(args, {
      userId: ctx.userId,
      roots: ctx.readableRoots,
      workspaceRoot: ctx.agentContext?.workspaceRoot,
    }),
  },
  // Unifies legacy's search-kb with the v2-only kb_search (sdk/tools.mjs
  // wrote a near-duplicate during the P1 spike — same kb.search call, a
  // slightly richer {query, limit} schema and {hits, total} shape). One
  // execute, one name, per the spec's §4 finding.
  { name: 'search-kb', kind: 'read', execute: (args, ctx) => searchKb(args, { kb: ctx.kb, userId: ctx.userId }) },
  { name: 'task-list', kind: 'read', execute: (args, ctx) => ({ tasks: tasks.listTasks(ctx.userId, ctx.sessionId) }) },
  {
    name: 'task-create',
    kind: 'act',
    gate: autoGate,
    execute: (args, ctx) => tasks.createTask(ctx.userId, ctx.sessionId, args.title),
  },
  {
    name: 'task-update',
    kind: 'act',
    gate: autoGate,
    execute: (args, ctx) => tasks.updateTask(ctx.userId, ctx.sessionId, args.taskId, { status: args.status, title: args.title }),
  },
  {
    name: 'run-bash',
    kind: 'act',
    gate: (args) => runBashGate(args.command),
    execute: (args, ctx) => handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot }),
  },
];

export function entries() {
  return ENTRIES;
}

export function names() {
  return Object.freeze(ENTRIES.map((e) => e.name));
}

export function get(name) {
  return ENTRIES.find((e) => e.name === name);
}

// Builds the dispatch table (name -> (args, loopCtx) => result) that
// route.mjs's runAgentLoop/runNativeAgentLoop hand to loop.mjs's
// runReadHandler. `ctx` is the per-request superset context (agentContext,
// runClaude, kb, userId, userSkills, userSubagents, internalSkills,
// internalModel, subagentModel, readableRoots, sessionId — see route.mjs's
// call site); `loopCtx` is per-call loop state (only depth, read by
// ask-internal/ask-subagent) threaded through by the caller, not by this
// function. Always produces exactly names()'s keys, so there is nothing
// left to drift-check against GLOBAL_HANDLER_NAMES.
export function buildDispatch(ctx) {
  const dispatch = {};
  for (const entry of ENTRIES) {
    dispatch[entry.name] = (args, loopCtx) => entry.execute(args, { ...ctx, loopCtx });
  }
  return dispatch;
}
