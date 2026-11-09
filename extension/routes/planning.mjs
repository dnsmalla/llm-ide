// Planning pipeline routes — generate-plan, analyze-risks, code-sync,
// the plan CRUD surface (/kb/plans, /kb/plan/:id, /kb/plan/save,
// /kb/plan/delete, /kb/plan-task/update), and the codegen + dispatch
// endpoints that operate on a plan's tasks. Extracted from
// kb/router.mjs as part of the modularization sweep.
//
// Contract:
//   handlePlanningRoutes(req, res, ctx) → boolean
//     ctx = { userId, url }
//     true  = route handled (response written)
//     false = not a planning route — caller continues dispatch

import * as kb from '../kb/db.mjs';
import { resolveReviewCreds, dropHeldSecrets } from '../server/review-secrets.mjs';
import { generatePlan } from '../agents/planner.mjs';
import { analyzeRisks } from '../agents/risk.mjs';
import { codeSync } from '../agents/code-sync.mjs';
import { dispatchPlan } from '../agents/dispatcher.mjs';
import { nudgeOutcomePoller } from '../agents/outcome-watcher.mjs';
import { generateCodeForTask } from '../agents/codegen.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { authorizeAction, hubFolderRefusal, projectScopeRefusal } from '../server/route-authority.mjs';
import { projectIdForFolder, getProject } from '../kb/projects.mjs';
import {
  assignPlanTask, assigneeEligibility, getTaskAssignment, getTaskContext, listMyAssignments, unassignPlanTask,
} from '../kb/plan-assignments.mjs';
import { recordActivity } from '../kb/activity.mjs';
import { clientIp, safeAudit } from '../server/route-http.mjs';

// Config keys that name WHERE a dispatch lands (github repo; backlog space +
// project; linear team + project). Pinned to the approved review.
const DISPATCH_DESTINATION_KEYS = ['repo', 'owner', 'space', 'teamId', 'projectId'];
const ASSIGN_KEYS = ['taskId', 'userId'];
const UNASSIGN_KEYS = ['taskId'];

/** An AppError from the assignment store is a client answer, not a 500. */
function sendStoreError(res, err) {
  if (err && err.name === 'AppError') {
    const code = err.code === 'VALIDATION' ? 'VALIDATION_FAILED' : (err.code || 'VALIDATION_FAILED');
    sendJSON(res, err.status || 400, { error: { code, message: err.message } });
    return true;
  }
  throw err;
}

function closedBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.includes(k)) return null;
    out[k] = v;
  }
  return out;
}

export async function handlePlanningRoutes(req, res, ctx) {
  const { userId, url } = ctx;

  // ── Plan generation pipeline: planner → risk → code-sync ─────
  //
  // The Chrome side panel + the Mac client both POST /kb/generate-plan
  // and expect a fully-formed plan back. skipRisk / skipCodeSync are
  // escape valves for the auto-stub flow that wants structure only.
  if (req.method === 'POST' && url === '/kb/generate-plan') {
    const body = parseJSON(await readBody(req, 1024 * 1024));
    if (!body?.meetingId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing meetingId' } });
      return true;
    }
    try {
      const draft = await generatePlan(userId, {
        meetingId: body.meetingId,
        goal: body.goal,
        language: body.language,
      });
      let plan = body.skipRisk ? draft : await analyzeRisks(userId, { plan: draft, language: body.language });
      plan = body.skipCodeSync ? plan : codeSync(userId, { plan });
      const saved = kb.savePlan(userId, plan);
      sendJSON(res, 200, saved);
    } catch (err) {
      sendJSON(res, 500, { error: { code: 'PLAN_GENERATION_FAILED', message: err.message || 'Plan generation failed' } });
    }
    return true;
  }

  // POST /kb/analyze-risks body: { planId | plan, language? }
  //   Recompute risk on an existing plan or a client-supplied draft.
  //   When planId is given, the result is persisted; with `plan` it's
  //   returned without writing (preview mode).
  if (req.method === 'POST' && url === '/kb/analyze-risks') {
    const body = parseJSON(await readBody(req, 2 * 1024 * 1024));
    if (!body?.planId && !body?.plan) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Provide planId or plan' } });
      return true;
    }
    try {
      const planInput = body.planId ? kb.getPlan(userId, body.planId) : body.plan;
      if (!planInput) {
        sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Plan not found' } });
        return true;
      }
      const updated = await analyzeRisks(userId, { plan: planInput, language: body.language });
      const saved = body.planId ? kb.savePlan(userId, updated) : updated;
      sendJSON(res, 200, saved);
    } catch (err) {
      sendJSON(res, 500, { error: { code: 'RISK_ANALYSIS_FAILED', message: err.message || 'Risk analysis failed' } });
    }
    return true;
  }

  // POST /kb/code-sync body: { planId | plan }
  //   Like analyze-risks: recompute code-sync (file references / repo
  //   matches) on an existing plan or a client draft.
  if (req.method === 'POST' && url === '/kb/code-sync') {
    const body = parseJSON(await readBody(req, 2 * 1024 * 1024));
    if (!body?.planId && !body?.plan) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Provide planId or plan' } });
      return true;
    }
    try {
      const planInput = body.planId ? kb.getPlan(userId, body.planId) : body.plan;
      if (!planInput) {
        sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Plan not found' } });
        return true;
      }
      const updated = codeSync(userId, { plan: planInput });
      const saved = body.planId ? kb.savePlan(userId, updated) : updated;
      sendJSON(res, 200, saved);
    } catch (err) {
      sendJSON(res, 500, { error: { code: 'CODE_SYNC_FAILED', message: err.message || 'Code sync failed' } });
    }
    return true;
  }

  // ── Plan CRUD ───────────────────────────────────────────────

  if (req.method === 'GET' && url.startsWith('/kb/plans')) {
    const u = new URL(url, 'http://127.0.0.1');
    const limit = Number(u.searchParams.get('limit') || 50);
    const plans = kb.listPlans(userId, limit);
    sendJSON(res, 200, { plans, count: plans.length });
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/kb/plan/')) {
    const id = decodeURIComponent(url.slice('/kb/plan/'.length).split('?')[0]);
    const plan = kb.getPlan(userId, id);
    if (!plan) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Plan not found' } });
      return true;
    }
    sendJSON(res, 200, plan);
    return true;
  }

  // POST /kb/plan/save — create or update a plan WITHOUT an LLM call.
  // Used by the "auto-stub on record" flow when there is no meeting
  // yet, and by inline rename. Accepts the same shape as savePlan:
  //   { id?, title, goal?, language?, tasks?, meetingId?, meta? }.
  // If id is omitted, a fresh stub is created.
  if (req.method === 'POST' && url === '/kb/plan/save') {
    const body = parseJSON(await readBody(req, 1024 * 1024));
    if (!body?.title) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing title' } });
      return true;
    }
    // A plan's meta.projectId puts its tasks on that project's board (GET /projects/:id/plan-tasks), so only
    // a project member may tag one; otherwise a non-member could plant tasks on another project's board.
    const taggedProject = body.meta && typeof body.meta === 'object' ? body.meta.projectId : undefined;
    if (taggedProject !== undefined && taggedProject !== null
      && !assigneeEligibility(kb.getDb(), userId, taggedProject).eligible) {
      sendJSON(res, 403, { error: { code: 'PROJECT_DENIED', message: 'You are not a member of that project' } });
      return true;
    }
    try {
      const saved = kb.savePlan(userId, {
        id: body.id,
        title: String(body.title).slice(0, 500),
        goal: typeof body.goal === 'string' ? body.goal.slice(0, 5000) : undefined,
        language: typeof body.language === 'string' ? body.language.slice(0, 16) : undefined,
        tasks: Array.isArray(body.tasks) ? body.tasks : [],
        meetingId: typeof body.meetingId === 'string' ? body.meetingId : undefined,
        meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
      });
      sendJSON(res, 200, saved);
    } catch (err) {
      sendJSON(res, 500, { error: { code: 'SAVE_FAILED', message: err.message || 'Save failed' } });
    }
    return true;
  }

  if ((req.method === 'DELETE' || req.method === 'POST') && url === '/kb/plan/delete') {
    const body = parseJSON(await readBody(req));
    if (!body?.id) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing plan id' } });
      return true;
    }
    kb.deletePlan(userId, body.id);
    sendJSON(res, 200, { ok: true });
    return true;
  }

  if ((req.method === 'PATCH' || req.method === 'POST') && url === '/kb/plan-task/update') {
    const body = parseJSON(await readBody(req));
    if (!body?.taskId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing taskId' } });
      return true;
    }
    const updated = kb.updateTask(userId, body.taskId, body.patch || {});
    if (!updated) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Task not found' } });
      return true;
    }
    sendJSON(res, 200, updated);
    return true;
  }

  // ── Plan task assignment (migration 0075) ───────────────────
  //
  //   GET  /kb/plan-task/assignments[?projectId=&limit=]  my assignments across projects
  //   POST /kb/plan-task/assign     { taskId, userId? }   assign/reassign (omitted userId = me)
  //   POST /kb/plan-task/unassign   { taskId }            clear the assignment
  //
  // The store enforces the project rules (assignee must be a project member, assigning someone
  // else needs project admin/owner, a member may claim an unassigned task). The route only parses
  // the body, audits the change and sends the in-app notification for a reassignment to someone else.

  if (req.method === 'GET' && url.startsWith('/kb/plan-task/assignments')) {
    const u = new URL(url, 'http://127.0.0.1');
    const limit = Number(u.searchParams.get('limit') || 100);
    const projectId = u.searchParams.get('projectId') || null;
    try {
      const assignments = listMyAssignments(kb.getDb(), userId, { limit, projectId });
      sendJSON(res, 200, { assignments, count: assignments.length });
    } catch (err) {
      return sendStoreError(res, err);
    }
    return true;
  }

  if (req.method === 'POST' && url === '/kb/plan-task/assign') {
    const body = parseJSON(await readBody(req));
    const input = closedBody(body, ASSIGN_KEYS);
    if (!input || typeof input.taskId !== 'string' || !input.taskId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'taskId is required' } });
      return true;
    }
    if (input.userId !== undefined && input.userId !== null && typeof input.userId !== 'string') {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'userId must be a string or null' } });
      return true;
    }
    const target = input.userId == null || input.userId === '' ? String(userId) : input.userId;
    const db = kb.getDb();
    const before = getTaskAssignment(db, input.taskId);
    try {
      const result = assignPlanTask(db, userId, input.taskId, target);
      const assignment = result.assignment;
      safeAudit(db, {
        userId,
        ip: clientIp(req),
        userAgent: req.headers?.['user-agent'] || '',
        action: 'plan.task.assign',
        resource: input.taskId,
        outcome: 'success',
        detail: {
          planId: assignment?.planId ?? before?.planId ?? null,
          projectId: assignment?.projectId ?? before?.projectId ?? null,
          fromUserId: before?.assignee?.userId ?? null,
          toUserId: target,
          reassigned: result.action === 'reassign',
          self: target === String(userId),
        },
      });
      if (result.changed && target !== String(userId)) {
        const task = getTaskContext(db, input.taskId);
        recordActivity({
          userId: target,
          kind: 'task_assigned',
          title: `Assigned to you: ${String(task?.title || 'a plan task').slice(0, 160)}`,
          detail: {
            taskId: input.taskId,
            planId: assignment?.planId ?? null,
            projectId: assignment?.projectId ?? null,
            assignedBy: userId,
          },
        });
      }
      sendJSON(res, 200, result);
    } catch (err) {
      return sendStoreError(res, err);
    }
    return true;
  }

  if (req.method === 'POST' && url === '/kb/plan-task/unassign') {
    const body = parseJSON(await readBody(req));
    const input = closedBody(body, UNASSIGN_KEYS);
    if (!input || typeof input.taskId !== 'string' || !input.taskId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'taskId is required' } });
      return true;
    }
    const db = kb.getDb();
    const before = getTaskAssignment(db, input.taskId);
    try {
      const result = unassignPlanTask(db, userId, input.taskId);
      if (result.unassigned) {
        safeAudit(db, {
          userId,
          ip: clientIp(req),
          userAgent: req.headers?.['user-agent'] || '',
          action: 'plan.task.unassign',
          resource: input.taskId,
          outcome: 'success',
          detail: {
            planId: before?.planId ?? null,
            projectId: before?.projectId ?? null,
            fromUserId: before?.assignee?.userId ?? null,
          },
        });
      }
      sendJSON(res, 200, result);
    } catch (err) {
      return sendStoreError(res, err);
    }
    return true;
  }

  // ── Dispatch + codegen ──────────────────────────────────────

  if (req.method === 'POST' && url === '/kb/dispatch') {
    const body = parseJSON(await readBody(req, 1024 * 1024));
    if (!body?.planId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing planId' } });
      return true;
    }
    const target = body.target || 'preview';
    let taskIds = body.taskIds;
    let dispatchConfig = body.config || {};
    // Guardrail gate: non-preview dispatch pushes tasks to external
    // systems (GitHub, Linear, Backlog) — require a pre-approved review
    // item so the user explicitly signs off before anything leaves the
    // local machine.  `preview` is exempt because it never calls any
    // external API and is used for dry-run validation.
    if (target !== 'preview') {
      if (!body.reviewId) {
        sendJSON(res, 403, {
          error: {
            code: 'REVIEW_REQUIRED',
            message: 'Non-preview dispatch requires a guardrail reviewId. '
                   + 'Submit /kb/review/submit (kind="dispatch") first, get it approved, '
                   + 'then include reviewId in this request.',
          },
        });
        return true;
      }
      const review = kb.getReview(userId, String(body.reviewId));
      if (!review || review.status !== 'approved') {
        sendJSON(res, 403, {
          error: {
            code: 'REVIEW_NOT_APPROVED',
            message: `reviewId ${body.reviewId} is not in approved state (current: ${review?.status ?? 'not found'})`,
          },
        });
        return true;
      }
      if (review.kind !== 'dispatch') {
        sendJSON(res, 403, {
          error: { code: 'REVIEW_KIND_MISMATCH', message: 'reviewId is not a dispatch review' },
        });
        return true;
      }
      // The approval covered one plan, target and task subset — dispatch
      // exactly that, so a request can't reuse an approval for different
      // tasks or another tracker.
      const approved = review.payload || {};
      const approvedPlanId = approved.planId ?? review.planId;
      if (approvedPlanId == null || String(approvedPlanId) !== String(body.planId)) {
        sendJSON(res, 403, {
          error: {
            code: 'REVIEW_PLAN_MISMATCH',
            message: 'reviewId does not match the requested planId',
          },
        });
        return true;
      }
      if (approved.target !== target) {
        sendJSON(res, 403, {
          error: {
            code: 'REVIEW_TARGET_MISMATCH',
            message: `reviewId was approved for target "${approved.target}", not "${target}"`,
          },
        });
        return true;
      }
      taskIds = approved.taskIds;
      // Destination identity is bound to the approval too: the reviewer
      // approved pushing to one repo/space/team/project. Credentials (token,
      // apiKey, …) may still come from the request, so only these keys are
      // pinned — a request naming a different destination is refused.
      const approvedCfg = approved.config && typeof approved.config === 'object' ? approved.config : {};
      const requestCfg = body.config && typeof body.config === 'object' ? body.config : {};
      for (const key of DISPATCH_DESTINATION_KEYS) {
        if (requestCfg[key] != null && String(requestCfg[key]) !== String(approvedCfg[key] ?? '')) {
          sendJSON(res, 409, {
            error: {
              code: 'REVIEW_CONFIG_MISMATCH',
              message: `config.${key} differs from the approved review's destination`,
            },
          });
          return true;
        }
      }
      dispatchConfig = { ...requestCfg };
      for (const key of DISPATCH_DESTINATION_KEYS) {
        if (approvedCfg[key] != null) dispatchConfig[key] = approvedCfg[key];
      }
      // Atomically consume the review (CAS: 'approved' → 'executed') so
      // two concurrent /kb/dispatch calls — or a race between this route
      // and /kb/review/approve's own execution — cannot both fire a
      // dispatch at the same external target.  If the CAS loses, the
      // review was already consumed by another request.
      const consumed = kb.setReviewStatus(userId, String(body.reviewId), {
        status: 'executed',
        expectedStatus: 'approved',
        reviewerNote: 'Consumed by /kb/dispatch',
      });
      if (!consumed) {
        sendJSON(res, 409, {
          error: {
            code: 'REVIEW_ALREADY_CONSUMED',
            message: `reviewId ${body.reviewId} was consumed by a concurrent request`,
          },
        });
        return true;
      }
    }
    try {
      const result = await dispatchPlan(userId, {
        planId: body.planId,
        target,
        taskIds,
        // Vault credential underneath; the request's config (destination
        // already pinned to the approval above) wins — but only its
        // non-empty values, so `token: ''` can't blank the vault credential
        // after the review was already consumed.
        config: {
          ...resolveReviewCreds(kb.getDb(), userId, { target }).config,
          ...Object.fromEntries(Object.entries(dispatchConfig).filter(([, v]) => v != null && v !== '')),
        },
      });
      // The approved review is consumed; its submit-time credentials are
      // no longer needed in memory.
      if (target !== 'preview' && body.reviewId) dropHeldSecrets(userId, String(body.reviewId));
      // A newly dispatched task is polled on the base interval, not after an idle hour (R-020 B#10).
      if (target !== 'preview') nudgeOutcomePoller();
      sendJSON(res, 200, result);
    } catch (err) {
      // Roll back the consumed review so the failure is visible and
      // recoverable — otherwise it stays 'executed' (falsely) and the CAS
      // above already consumed the 'approved' slot, so the dispatch can't be
      // retried. Mirrors /kb/review/approve's own failure handling. Only
      // non-preview dispatch consumes a review.
      if (target !== 'preview' && body.reviewId) {
        kb.setReviewStatus(userId, String(body.reviewId), {
          status: 'failed',
          result: { error: err.message || 'Dispatch failed' },
        });
      }
      sendJSON(res, 400, { error: { code: 'DISPATCH_FAILED', message: err.message || 'Dispatch failed' } });
    }
    return true;
  }

  if (req.method === 'POST' && url === '/kb/generate-code') {
    const body = parseJSON(await readBody(req, 1024 * 1024));
    if (!body?.taskId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing taskId' } });
      return true;
    }
    // R-021 #2: code generation is project work; a named project must own the repo folder (R-021 #1) and a hub
    // requires one.
    const named = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    const folderPath = typeof body.repo === 'string' && body.repo ? body.repo : null;
    const folder = folderPath ? projectIdForFolder(kb.getDb(), folderPath) : null;
    if (named && folder && named !== folder) {
      sendJSON(res, 403, { error: { code: 'PROJECT_MISMATCH', message: 'That project does not own this folder' } });
      return true;
    }
    // R-023 #1: on a hub the repo folder must belong to a project.
    const hubRefusal = hubFolderRefusal(folderPath, folder);
    if (hubRefusal) { sendJSON(res, hubRefusal.status, { error: { code: hubRefusal.code, message: hubRefusal.message } }); return true; }
    const projectId = folder || named;
    const scope = projectScopeRefusal(kb.getDb(), userId, projectId);
    if (scope) { sendJSON(res, scope.status, { error: { code: scope.code, message: scope.message } }); return true; }
    if (projectId) {
      const decision = authorizeAction(kb.getDb(), userId, 'model.ask', { projectId, req });
      if (!decision.ok) { sendJSON(res, decision.status, { error: { code: decision.code, message: decision.message } }); return true; }
    }
    try {
      // R-034 #3: the plan project's root is the containment boundary for every file ref codegen reads.
      const project = projectId ? getProject(kb.getDb(), projectId) : null;
      const result = await generateCodeForTask(userId, {
        taskId: body.taskId,
        language: body.language,
        includeFileContext: body.includeFileContext !== false,
        projectRoot: project?.root ?? null,
      });
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 500, { error: { code: 'CODEGEN_FAILED', message: err.message || 'Code generation failed' } });
    }
    return true;
  }

  return false;
}
