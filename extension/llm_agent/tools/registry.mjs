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
// PLUS `loopCtx` (`ask-internal`/`ask-subagent` read it for `depth`;
// `run-bash` reads it for `emit`). `loopCtx` is also the ENGINE
// DISCRIMINATOR: only the legacy dispatch path (buildDispatch, below) ever
// sets it — v2 calls `execute` with sdk/tools.mjs's flat toolCtx, which has no
// such field. run-bash relies on that to know which engine owns its gate.
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
import { handleProjectMemory } from '../runtime/handlers/project-memory.mjs';
import { handleLoadSkill } from '../runtime/handlers/load-skill.mjs';
import { runBashGate, autoGate } from './gates.mjs';
import { registerDecision, abortDecisionsForSession } from '../sdk/decisions.mjs';
import { hasAlwaysAllow, setAlwaysAllow } from '../../kb/tool-approvals.mjs';

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
  // Reads one SKILL.md out of the user's own library so a skill that ends by
  // naming another skill can hand over to it (runtime/plan-pipeline.mjs's
  // stage 2 is the motivating case). kind:'read' by construction — it
  // resolves the id through the catalog-gated reader and returns text —
  // which also makes it available in every restricted mode, where the
  // hand-off matters most.
  { name: 'load-skill', kind: 'read', execute: (args, ctx) => handleLoadSkill(args, { userId: ctx.userId }) },
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
    async execute(args, ctx) {
      // ONE gate per engine. `ctx.loopCtx` is the discriminator:
      //
      //  - PRESENT  => legacy engine. buildDispatch (below) always nests the
      //    loop's per-call ctx under `loopCtx`, and loop.mjs always passes one
      //    (`{ userId, kb, handlers, depth, emit }`). Legacy has no SDK-level
      //    permission hook, so THIS function is the gate — full gate + park
      //    logic below, unchanged.
      //  - ABSENT   => v2 engine. sdk/tools.mjs's toolCtx has no `loopCtx`
      //    field at all. On v2 the SOLE gate is engine.mjs's `canUseTool`
      //    (run-bash is deliberately NOT in `allowedTools`, so the SDK must
      //    consult it): by the time the SDK actually invokes the mounted tool
      //    function, canUseTool has already returned 'allow' for this exact
      //    invocation. Re-gating here would be redundant AND broken — there is
      //    no emit channel on v2, so a second parked decision could never be
      //    answered and would hang the full 300 s before denying.
      if (!ctx.loopCtx) {
        return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot });
      }
      // Gate FIRST, always-allow only short-circuits the 'prompt' tier —
      // see the identical fix + rationale in Task 7's canUseTool. Checking
      // always-allow before the gate would let a run-bash always-allowed for
      // one safe command bypass the blocked check on every later invocation.
      const decision = runBashGate(args.command);
      if (decision === 'blocked') return { error: 'Command blocked for safety. Confirm destructive operations with the user before running.' };
      if (decision === 'auto') return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot });
      // decision === 'prompt' — always-allow only matters here.
      if (hasAlwaysAllow(ctx.userId, 'run-bash')) {
        return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot });
      }
      // No live emit channel => no human can ever see this approval. That is
      // exactly the BUFFERED (non-SSE) /code-assist path, which passes no
      // onProgress at all (server/ai-routes.mjs): parking there would hang the
      // turn for the registry's full 300 s and then deny anyway. Fail fast
      // with an actionable message instead.
      if (typeof ctx.loopCtx.emit !== 'function') {
        return { error: 'This command needs interactive approval — please use a message that streams a live response.' };
      }
      // Same park-and-await pattern as v2's canUseTool, reusing the SAME
      // dependency-free decisions.mjs registry (spec §7).
      const sessionKey = ctx.agentContext?.sessionId;
      const { requestId, promise } = registerDecision({ sdkSessionId: sessionKey, userId: ctx.userId, kind: 'ToolApproval' });
      try {
        // buildDispatch's dispatch function is `(args, loopCtx) =>
        // entry.execute(args, { ...ctx, loopCtx })` — the per-call ctx that
        // runReadHandler/runNativeAgentLoop pass in arrives HERE as
        // `ctx.loopCtx`, not spread onto `ctx` itself (same convention
        // ask-internal/ask-subagent already rely on for `ctx.loopCtx?.depth`).
        // `emit` therefore lives at `ctx.loopCtx.emit`, never `ctx.emit`.
        ctx.loopCtx?.emit?.({ phase: 'approval_request', requestId, kind: 'ToolApproval', toolName: 'run-bash', argsSummary: args.command });
      } catch {
        abortDecisionsForSession(sessionKey);
        return { error: 'Failed to surface the approval request.' };
      }
      const outcome = await promise;
      if (outcome.action === 'always-allow') { setAlwaysAllow(ctx.userId, 'run-bash'); return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot }); }
      if (outcome.action === 'allow') return handleRunBash(args, { workspaceRoot: ctx.agentContext?.workspaceRoot });
      return { error: 'Command not approved by the user.' };
    },
  },
  {
    name: 'project_memory',
    kind: 'read',
    execute: (args, ctx) => handleProjectMemory(args, { agentContext: ctx.agentContext, userId: ctx.userId, currentMessage: ctx.currentMessage, renderMemory: ctx.renderMemory }),
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
