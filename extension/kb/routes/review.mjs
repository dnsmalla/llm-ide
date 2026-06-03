// /kb/review/* routes — the user-approval queue for guardrailed
// actions (codegen-apply, dispatchPlan). Submit puts an item in
// "pending" state; approve re-runs guardrails right before execution
// (payloads can drift) and dispatches the actual side-effect.
// Extracted from kb/router.mjs as part of the modularization sweep.
//
// Contract:
//   handleReviewRoutes(req, res, ctx) → boolean
//     ctx = { userId, url }

import fs from 'node:fs';
import path from 'node:path';
import * as kb from '../db.mjs';
import { dispatchPlan } from '../../agents/dispatcher.mjs';
import { applyCodegen } from '../../agents/codegen-apply.mjs';
import { openPullRequest } from '../../agents/github-pr.mjs';
import { runGuardrails } from '../../guardrails/rules.mjs';
import { sendJSON, readBody, parseJSON } from '../../core/utils.mjs';

export async function handleReviewRoutes(req, res, ctx) {
  const { userId, url } = ctx;
  if (!url.startsWith('/kb/review')) return false;

  // POST /kb/review/submit — drop an action onto the user's queue.
  // For codegen-apply, OVERRIDE the client-supplied allowedRepos with
  // the server-side per-user list. The guardrail engine then checks
  // against authoritative data, so a malicious client can't escape
  // its sandbox by sending {allowedRepos: ['/']}.
  if (req.method === 'POST' && url === '/kb/review/submit') {
    const body = parseJSON(await readBody(req, 8 * 1024 * 1024));
    if (!body?.kind || !body?.payload) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'kind and payload required' } });
      return true;
    }
    const payload = { ...body.payload };
    if (body.kind === 'codegen-apply') {
      payload.allowedRepos = kb.userRepoAllowlist(userId);
    }
    const guardrails = runGuardrails(body.kind, payload);
    try {
      const item = kb.submitReview(userId, {
        kind: body.kind,
        planId: body.planId,
        taskId: body.taskId,
        title: body.title,
        payload,
        guardrails,
      });
      sendJSON(res, 200, item);
    } catch (err) {
      sendJSON(res, 400, { error: { code: 'REVIEW_SUBMIT_FAILED', message: err.message } });
    }
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/kb/review/list')) {
    const u = new URL(url, 'http://127.0.0.1');
    const status = u.searchParams.get('status') || undefined;
    const limit = Number(u.searchParams.get('limit') || 50);
    const items = kb.listReviews(userId, { status, limit });
    sendJSON(res, 200, { items, count: items.length });
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/kb/review/get/')) {
    const id = decodeURIComponent(url.slice('/kb/review/get/'.length).split('?')[0]);
    const item = kb.getReview(userId, id);
    if (!item) { sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } }); return true; }
    sendJSON(res, 200, item);
    return true;
  }

  if (req.method === 'POST' && url === '/kb/review/reject') {
    const body = parseJSON(await readBody(req));
    if (!body?.id) { sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing id' } }); return true; }
    const updated = kb.setReviewStatus(userId, body.id, {
      status: 'rejected',
      reviewerNote: body.note,
    });
    if (!updated) { sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } }); return true; }
    sendJSON(res, 200, updated);
    return true;
  }

  // POST /kb/review/approve — the big one. Re-runs guardrails,
  // claims the item via compare-and-swap, executes the action, and
  // writes the result back. Compare-and-swap on `pending` so two
  // concurrent approves of the same item can't both proceed (e.g.
  // double-click).
  if (req.method === 'POST' && url === '/kb/review/approve') {
    const body = parseJSON(await readBody(req, 4 * 1024 * 1024));
    if (!body?.id) { sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing id' } }); return true; }
    const item = kb.getReview(userId, body.id);
    if (!item) { sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } }); return true; }
    if (item.status !== 'pending') {
      sendJSON(res, 409, { error: { code: 'REVIEW_NOT_PENDING', message: `Item already ${item.status}` } });
      return true;
    }

    // Re-run guardrails right before execution — payloads can be
    // tampered with on disk and the cost is microseconds. For
    // codegen-apply, ALWAYS use the server-side allow-list at decision
    // time, even if the stored payload has a stale value from submit.
    const evalPayload = { ...item.payload };
    if (item.kind === 'codegen-apply') {
      evalPayload.allowedRepos = kb.userRepoAllowlist(userId);
    }
    const guardrails = runGuardrails(item.kind, evalPayload);
    if (!guardrails.passed) {
      const refreshed = kb.setReviewStatus(userId, body.id, {
        status: 'rejected',
        reviewerNote: 'Auto-rejected: guardrails fail at approval time.',
      });
      sendJSON(res, 422, { error: { code: 'GUARDRAILS_FAILED', message: 'Guardrails fail at approval time' }, guardrails, item: refreshed });
      return true;
    }

    // Mark approved first so a crash mid-execution leaves a recoverable trace.
    const claimed = kb.setReviewStatus(userId, body.id, {
      status: 'approved',
      reviewerNote: body.note,
      expectedStatus: 'pending',
    });
    if (!claimed) {
      sendJSON(res, 409, { error: { code: 'REVIEW_RACE', message: 'Item is no longer pending (raced by another request)' } });
      return true;
    }

    try {
      let result;
      if (item.kind === 'dispatch') {
        result = await dispatchPlan(userId, {
          planId: item.payload.planId,
          target: item.payload.target,
          taskIds: item.payload.taskIds,
          config: item.payload.config || {},
        });
      } else if (item.kind === 'codegen-apply') {
        const apply = applyCodegen({
          repoPath: item.payload.repoPath,
          taskId: item.payload.taskId,
          files: item.payload.files,
          tests: item.payload.tests,
          allowedRepos: kb.userRepoAllowlist(userId),
        });
        // Optional follow-on: open a draft PR with the just-applied
        // files committed onto a fresh branch. Triggered only when
        // payload.pr is fully specified — a missing config means the
        // reviewer chose "files only" and we stop after writing.
        let pr;
        if (item.payload.pr && item.payload.pr.ghRepo && item.payload.pr.ghToken) {
          pr = await openPullRequest({
            repoPath: item.payload.repoPath,
            taskId: item.payload.taskId,
            files: item.payload.files,
            tests: item.payload.tests,
            summary: item.payload.summary,
            ghRepo: item.payload.pr.ghRepo,
            ghToken: item.payload.pr.ghToken,
            baseBranch: item.payload.pr.baseBranch,
          });
        }
        result = pr ? { ...apply, pr } : apply;
      } else {
        throw new Error(`Unknown review kind: ${item.kind}`);
      }
      const finished = kb.setReviewStatus(userId, body.id, { status: 'executed', result });
      sendJSON(res, 200, finished);
    } catch (err) {
      const finished = kb.setReviewStatus(userId, body.id, {
        status: 'failed',
        result: { error: err.message || 'execution failed' },
      });
      sendJSON(res, 500, { error: { code: 'REVIEW_EXECUTION_FAILED', message: err.message || 'execution failed' }, item: finished });
    }
    return true;
  }

  if ((req.method === 'DELETE' || req.method === 'POST') && url === '/kb/review/delete') {
    const body = parseJSON(await readBody(req));
    if (!body?.id) { sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Missing id' } }); return true; }
    kb.deleteReview(userId, body.id);
    sendJSON(res, 200, { ok: true });
    return true;
  }

  // POST /kb/review/cleanup-artifacts
  // Remove the `.meetnotes-auto/<taskId>/` directory that codegen-apply
  // wrote.  Called after the user integrates (or rejects) the generated
  // files so they don't accumulate in the working tree.
  //
  // Safety rules:
  //   1. repoPath must be on the user's server-side allow-list.
  //   2. taskId is slugified to [A-Za-z0-9_.-] so the derived path
  //      stays inside `.meetnotes-auto/<safeSlug>/` and can never
  //      escape with ".." or leading slashes.
  //   3. We only remove directories (not arbitrary paths).
  if (req.method === 'POST' && url === '/kb/review/cleanup-artifacts') {
    const body = parseJSON(await readBody(req));
    const { repoPath, taskId } = body || {};
    if (!repoPath || !taskId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'repoPath and taskId required' } });
      return true;
    }
    // Allow-list check.
    const allowedRepos = kb.userRepoAllowlist(userId);
    const normalRepo = String(repoPath).replace(/\/+$/, '');
    if (!allowedRepos.some((r) => normalRepo === r.replace(/\/+$/, '') || normalRepo.startsWith(r.replace(/\/+$/, '') + '/'))) {
      sendJSON(res, 403, { error: { code: 'REPO_NOT_ALLOWED', message: 'repoPath is not in your allow-list' } });
      return true;
    }
    // Slug-safe taskId — no path traversal possible.
    const safeTask = String(taskId).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
    if (!safeTask) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'taskId is invalid' } });
      return true;
    }
    const artifactDir = path.join(normalRepo, '.meetnotes-auto', safeTask);
    // Use realpathSync (not path.resolve) so symlinks in the repo path
    // are resolved before the containment check — path.resolve is purely
    // lexical and can be fooled by a symlinked repoPath on the allow-list.
    let resolved, resolvedRepo;
    try {
      // realpathSync only works on existing paths; the artifact dir may
      // not exist yet (that is fine — rmSync with force:true is a no-op).
      // Resolve the repo root (which MUST exist) and then reconstruct the
      // artifact path from there lexically.
      resolvedRepo = fs.realpathSync(normalRepo);
      resolved = path.join(resolvedRepo, '.meetnotes-auto', safeTask);
    } catch (err) {
      sendJSON(res, 403, { error: { code: 'REPO_RESOLVE_FAILED', message: `Cannot resolve repoPath: ${err.message}` } });
      return true;
    }
    if (!resolved.startsWith(resolvedRepo + path.sep) && resolved !== resolvedRepo) {
      sendJSON(res, 403, { error: { code: 'PATH_ESCAPE', message: 'Computed path escapes repoPath' } });
      return true;
    }
    try {
      fs.rmSync(artifactDir, { recursive: true, force: true });
      sendJSON(res, 200, { ok: true, removed: artifactDir });
    } catch (err) {
      sendJSON(res, 500, { error: { code: 'CLEANUP_FAILED', message: err.message } });
    }
    return true;
  }

  return false;
}
