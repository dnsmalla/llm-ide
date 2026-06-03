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

import * as kb from '../db.mjs';
import { generatePlan } from '../../agents/planner.mjs';
import { analyzeRisks } from '../../agents/risk.mjs';
import { codeSync } from '../../agents/code-sync.mjs';
import { dispatchPlan } from '../../agents/dispatcher.mjs';
import { generateCodeForTask } from '../../agents/codegen.mjs';
import { sendJSON, readBody, parseJSON } from '../../core/utils.mjs';

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

  // ── Dispatch + codegen ──────────────────────────────────────

  if (req.method === 'POST' && url === '/kb/dispatch') {
    const body = parseJSON(await readBody(req, 1024 * 1024));
    if (!body?.planId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing planId' } });
      return true;
    }
    const target = body.target || 'preview';
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
      if (review.planId && review.planId !== String(body.planId)) {
        sendJSON(res, 403, {
          error: {
            code: 'REVIEW_PLAN_MISMATCH',
            message: 'reviewId does not match the requested planId',
          },
        });
        return true;
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
        taskIds: body.taskIds,
        config: body.config || {},
      });
      sendJSON(res, 200, result);
    } catch (err) {
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
    try {
      const result = await generateCodeForTask(userId, {
        taskId: body.taskId,
        language: body.language,
        includeFileContext: body.includeFileContext !== false,
      });
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 500, { error: { code: 'CODEGEN_FAILED', message: err.message || 'Code generation failed' } });
    }
    return true;
  }

  return false;
}
