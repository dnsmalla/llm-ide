// /kb/agent/* HTTP surface — dispatch, stop, persona registry,
// ask-the-agent chat, feedback. Extracted from kb/router.mjs as
// part of the modularization sweep.
//
// Contract:
//   handleAgentRoutes(req, res, ctx) → boolean
//     ctx = { userId, url }
//     true  = route handled (response written)
//     false = not an /kb/agent/* request — caller continues dispatch

import * as kb from '../kb/db.mjs';
import { dispatchAgent, stopAgent, listRuns, getDiagnostics } from '../agents/meeting-agent.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { listAllSkills, listInstalledPlugins, buildPerUserSkillSet, listSkillLibrary } from '../llm_agent/skills/index.mjs';
import {
  buildAllowedRoots,
  resolveAllowedRepoRoot,
  readChatMemoryFacts,
  writeChatMemoryFacts,
  factIndex,
} from '../graphkit/index.mjs';
import { deleteSessionMemory, listSessionMemory } from '../kb/session-memory.mjs';
import { listAlwaysAllow, clearAlwaysAllow, clearAllAlwaysAllow } from '../kb/tool-approvals.mjs';
import { listRules, removeRule, removeAllRules } from '../kb/tool-permissions.mjs';

export async function handleAgentRoutes(req, res, ctx) {
  const { userId, url } = ctx;
  if (!url.startsWith('/kb/agent')) return false;

  // POST /kb/agent/dispatch  body: { sessionId?, planId?, persona?, language?, meetingUrl? }
  //   Attaches the agent question-loop to one of the user's active
  //   live capture sessions. No bot, no third-party transport — the
  //   user is already capturing via the extension or Mac app, and
  //   the agent reads/writes the same /kb/live/<sessionId> stream.
  if (req.method === 'POST' && url === '/kb/agent/dispatch') {
    const body = parseJSON(await readBody(req, 4 * 1024)) || {};
    try {
      const result = await dispatchAgent({
        userId,
        sessionId: body.sessionId || null,
        planId: body.planId || null,
        persona: body.persona || null,
        language: typeof body.language === 'string' ? body.language : null,
        meetingUrl: typeof body.meetingUrl === 'string' ? body.meetingUrl : null,
      });
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 400, { error: { code: 'AGENT_DISPATCH_FAILED', message: err.message || 'dispatch failed' } });
    }
    return true;
  }

  // POST /kb/agent/stop body: { sessionId }
  //   Detaches the loop. The capture itself keeps running.
  if (req.method === 'POST' && url === '/kb/agent/stop') {
    const body = parseJSON(await readBody(req, 4 * 1024)) || {};
    if (!body.sessionId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'sessionId required' } });
      return true;
    }
    const result = await stopAgent({ userId, sessionId: body.sessionId });
    sendJSON(res, 200, result);
    return true;
  }

  // GET /kb/agent/runs → which sessions have the agent attached.
  if (req.method === 'GET' && url === '/kb/agent/runs') {
    sendJSON(res, 200, { runs: listRuns(userId) });
    return true;
  }

  // GET /kb/agent/diagnose → last dispatch + active-run count.
  if (req.method === 'GET' && url === '/kb/agent/diagnose') {
    const diag = getDiagnostics(userId);
    sendJSON(res, 200, {
      lastDispatch: diag.lastDispatch,
      activeRuns: diag.activeRuns.length,
    });
    return true;
  }

  // Persona (legacy single-persona surface — returns the active row).
  //   GET /kb/agent/persona → user's stored persona, or null
  //   PUT /kb/agent/persona body { name?, promptSuffix?, autoDispatch? }
  //     → upsert; all-empty resets to defaults
  if (req.method === 'GET' && url === '/kb/agent/persona') {
    sendJSON(res, 200, { persona: kb.getAgentPersona(userId) });
    return true;
  }
  if (req.method === 'PUT' && url === '/kb/agent/persona') {
    const body = parseJSON(await readBody(req, 8 * 1024)) || {};
    const saved = kb.setAgentPersona(userId, body);
    sendJSON(res, 200, { persona: saved });
    return true;
  }

  // POST /kb/agent/feedback body: { sessionId, captionSeq, verdict, planTaskId?, score? }
  //   verdict: "useful" | "noise" | "later"
  if (req.method === 'POST' && url === '/kb/agent/feedback') {
    const body = parseJSON(await readBody(req, 4 * 1024)) || {};
    try {
      kb.recordAgentFeedback(userId, {
        sessionId: body.sessionId,
        captionSeq: body.captionSeq,
        verdict: body.verdict,
        planTaskId: body.planTaskId,
        score: body.score,
      });
      sendJSON(res, 200, { ok: true });
    } catch (err) {
      sendJSON(res, 400, { error: { code: 'FEEDBACK_FAILED', message: err.message || 'feedback failed' } });
    }
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/kb/agent/feedback/stats')) {
    const u = new URL(url, 'http://127.0.0.1');
    const sinceDays = Number(u.searchParams.get('sinceDays') || 30);
    sendJSON(res, 200, kb.agentFeedbackStats(userId, { sinceDays }));
    return true;
  }

  // GET /kb/agent/catalog
  //   Executable skills + plugin subagents for the Code Assistant "/" menu.
  //   { skills: { global, internal, plugins }, subagents: { plugins } }
  if (req.method === 'GET' && url === '/kb/agent/catalog') {
    const skills = listAllSkills();
    const installed = listInstalledPlugins(userId);
    const pluginSubagents = [];
    for (const p of installed.plugins) {
      if (p.subagents && p.subagents.length > 0) {
        pluginSubagents.push({
          pluginName: p.name,
          pluginDisplayName: p.displayName || p.name,
          subagents: p.subagents,
        });
      }
    }
    sendJSON(res, 200, {
      skills,
      subagents: { plugins: pluginSubagents },
    });
    return true;
  }

  // GET /kb/agent/commands
  //   Enabled slash-commands for THIS user (plugin-enable-aware), powering the
  //   chat input's "/" autocomplete.
  //   { commands: [{ trigger, description, args: [{name, required}], pluginName }] }
  if (req.method === 'GET' && url.split('?')[0] === '/kb/agent/commands') {
    const { commands } = buildPerUserSkillSet(userId);
    const list = [];
    for (const [trigger, cmd] of commands) {
      list.push({
        trigger,
        description: cmd.description || '',
        args: Object.entries(cmd.args || {}).map(([name, def]) => ({
          name,
          required: !!(def && def.required),
        })),
        pluginName: cmd.pluginName || null,
      });
    }
    list.sort((a, b) => a.trigger.localeCompare(b.trigger));
    sendJSON(res, 200, { commands: list });
    return true;
  }

  // GET /kb/agent/skill-library
  //   The skills discovery catalog: iterates the user's ENABLED skills sources
  //   (the `skills/` + `runtime/` families NOT already in /kb/agent/catalog)
  //   for the chat "/" menu. The agent can't execute these; the client attaches
  //   a chosen skill's SKILL.md as context.
  //   { repo: <builtin path|null>, skills: [{id, family, name, description, path, sourceId, sourceName}] }
  if (req.method === 'GET' && url.split('?')[0] === '/kb/agent/skill-library') {
    sendJSON(res, 200, listSkillLibrary(userId));
    return true;
  }

  // GET /kb/agent/project-memory?repo=<path>[&repo=<path>…]
  //   The auto-captured chat-memory facts for the viewer. The client sends its
  //   indexedRepos candidate paths; we resolve the FIRST allow-listed one —
  //   exactly what memory-persist writes to — so the viewer always reads the
  //   same file the agent captures into (not blindly indexedRepos[0], which may
  //   not be allow-listed). Returns the resolved absolute root for the viewer
  //   to target subsequent DELETEs. { facts: string[], repo: <root | null> }
  if (req.method === 'GET' && new URL(url, 'http://127.0.0.1').pathname === '/kb/agent/project-memory') {
    const params = new URL(url, 'http://127.0.0.1').searchParams;
    const workspaceRoot = params.get('workspaceRoot') || undefined;
    // Try indexed-repo candidates then the open workspace folder (so the viewer
    // resolves the same target memory-persist/renderGraphifyMemory now use).
    const candidates = [...params.getAll('repo'), ...(workspaceRoot ? [workspaceRoot] : [])];
    const allowed = buildAllowedRoots(userId, workspaceRoot);
    let root = null;
    if (allowed) {
      for (const c of candidates) { root = resolveAllowedRepoRoot(c, allowed); if (root) break; }
    }
    if (!root) { sendJSON(res, 200, { facts: [], repo: null }); return true; }
    sendJSON(res, 200, { facts: readChatMemoryFacts(root), repo: root });
    return true;
  }

  // GET /kb/agent/tool-approvals
  //   The user's "always allow" permission rules, grouped by project on the
  //   client: { rules: [{ projectRoot, toolName, pattern, grantedAt }],
  //             approvals: [{ toolName, grantedAt }] }
  //   `approvals` are the pre-0034 global grants — no longer honoured by
  //   either engine, still listed (and revocable) so nothing is invisible.
  if (req.method === 'GET' && new URL(url, 'http://127.0.0.1').pathname === '/kb/agent/tool-approvals') {
    sendJSON(res, 200, { rules: listRules(userId), approvals: listAlwaysAllow(userId) });
    return true;
  }

  // DELETE /kb/agent/tool-approvals
  //   body: { projectRoot, toolName, pattern } — one project rule
  //       | { toolName }                      — one legacy global grant
  //       | { all: true }                     — everything
  //   Revocation only ever removes permission, so there is nothing to gate:
  //   the worst case is the user is asked again.
  //   { rules: [...], approvals: [...remaining], removed: number }
  if (req.method === 'DELETE' && new URL(url, 'http://127.0.0.1').pathname === '/kb/agent/tool-approvals') {
    const body = parseJSON(await readBody(req, 8 * 1024)) || {};
    const listing = () => ({ rules: listRules(userId), approvals: listAlwaysAllow(userId) });
    if (body.all === true) {
      const removed = removeAllRules(userId) + clearAllAlwaysAllow(userId);
      sendJSON(res, 200, { ...listing(), removed });
      return true;
    }
    if (typeof body.projectRoot === 'string' && body.projectRoot && typeof body.toolName === 'string' && body.toolName) {
      const removed = removeRule(userId, {
        projectRoot: body.projectRoot, toolName: body.toolName,
        pattern: typeof body.pattern === 'string' ? body.pattern : '',
      }) ? 1 : 0;
      sendJSON(res, 200, { ...listing(), removed });
      return true;
    }
    if (typeof body.toolName !== 'string' || !body.toolName) {
      // VALIDATION_FAILED, not an invented code: it is the canonical 400 in
      // core/errors.mjs and the only 400 code the documented Error schema's
      // enum admits (docs/reference/api/openapi.yaml).
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'toolName or all:true required' } });
      return true;
    }
    const removed = clearAlwaysAllow(userId, body.toolName) ? 1 : 0;
    sendJSON(res, 200, { ...listing(), removed });
    return true;
  }

  // DELETE /kb/agent/project-memory   body: { repo, fact } | { repo, all: true }
  //   Remove one captured fact, or clear them all, for a repo. Same gate.
  //   { facts: string[] }  (the remaining facts)
  if (req.method === 'DELETE' && new URL(url, 'http://127.0.0.1').pathname === '/kb/agent/project-memory') {
    const body = parseJSON(await readBody(req, 8 * 1024)) || {};
    // Allow the resolved workspace root too — the GET may have resolved memory
    // to the open folder, so its DELETEs target that same (validated) root.
    const allowed = buildAllowedRoots(userId, typeof body.workspaceRoot === 'string' ? body.workspaceRoot : undefined);
    const root = allowed ? resolveAllowedRepoRoot(body.repo, allowed) : null;
    if (!root) {
      sendJSON(res, 404, { error: { code: 'REPO_NOT_ALLOWED', message: 'repo not in allow-list' } });
      return true;
    }
    if (body.all === true) {
      sendJSON(res, 200, { facts: writeChatMemoryFacts(root, []) });
      return true;
    }
    // `factIndex`, not `factKey`: factIndex is the store's own identity (what
    // parseChatMemoryFacts dedupes on), so it deletes exactly the row the
    // viewer showed. factKey strips the tag and leading filler, so two facts
    // with different subject ids but the same text — `[db|engine] uses SQLite`
    // and `[perf|store] the project uses SQLite` — would BOTH be deleted by a
    // single click.
    const target = factIndex(body.fact);
    const remaining = readChatMemoryFacts(root).filter((f) => factIndex(f) !== target);
    sendJSON(res, 200, { facts: writeChatMemoryFacts(root, remaining) });
    return true;
  }

  // GET /kb/agent/session-memory?sessionId=<chat uuid>
  //   What THIS chat's memory holds — the conversation-state sentences and
  //   the project facts it taught — for the memory viewer. Until this route
  //   existed the table was write-and-delete only: the user could not see
  //   what the assistant was carrying between turns, which read as "session
  //   memory isn't used". Not repo-scoped (see the DELETE below).
  //   { facts: string[] }
  if (req.method === 'GET' && new URL(url, 'http://127.0.0.1').pathname === '/kb/agent/session-memory') {
    const sessionId = (new URL(url, 'http://127.0.0.1').searchParams.get('sessionId') || '').trim();
    if (!sessionId) {
      sendJSON(res, 400, { error: { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' } });
      return true;
    }
    sendJSON(res, 200, { facts: listSessionMemory(userId, sessionId) });
    return true;
  }

  // DELETE /kb/agent/session-memory   body: { sessionId }
  //   Delete everything session_memory captured for ONE chat session — called
  //   when the user deletes or clears that chat, so its memory doesn't
  //   outlive it. A REAL DB delete (kb/session-memory.mjs), scoped to this
  //   userId's own rows. Unlike project memory (chat-memory.md, above), which
  //   is durable and never touched by a session's lifecycle — only its own
  //   explicit per-fact edit/delete — session memory is meant to disappear
  //   with its session, so no allow-list/repo resolution is needed here at
  //   all: it isn't repo-scoped.
  //   { removed: number }
  if (req.method === 'DELETE' && new URL(url, 'http://127.0.0.1').pathname === '/kb/agent/session-memory') {
    const body = parseJSON(await readBody(req, 8 * 1024)) || {};
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      sendJSON(res, 400, { error: { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' } });
      return true;
    }
    const removed = deleteSessionMemory(userId, sessionId);
    sendJSON(res, 200, { removed });
    return true;
  }

  return false;
}
