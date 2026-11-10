// POST /kb/projects/register: the per-user project id -> folder map and the canonical project registry row.
// Always on, not a Doc Gen route: the command bus's review and the task route need a registered project, so
// this path is not in the doc_gen group (routes/feature-routes.mjs). The handler is moved unchanged from
// routes/docs-routes.mjs; the JSON-body helpers it shares with the /kb/docs/* routes live here too.
//
//   POST /kb/projects/register   { id, root, name? } -> { id, root, name }
//
// handleProjectRegister(req, res, ctx) -> boolean, ctx = { userId, url, dir? }.

import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.mjs';
import { config } from '../core/config.mjs';
import { persistTeamYaml } from '../kb/team-yaml.mjs';
import { readBody, parseJSON, sendJSON } from '../core/utils.mjs';
import { DocFilesError } from '../kb/doc-project-files.mjs';
import { registerProjectRoot } from '../kb/project-roots.mjs';
import { getDb } from '../kb/db.mjs';
import { canManageProject, getProject, projectIdForRoot, registerProject } from '../kb/projects.mjs';

const REGISTER = '/kb/projects/register';

/** Upper bound for a JSON object body (the docs routes and the register route share it). */
export const DOCS_BODY_LIMIT = 512 * 1024;

export function fail(res, err) {
  if (err instanceof DocFilesError) {
    // A DocFilesError may carry its own status (409 for an ingest layout).
    const status = err.status ?? FAIL[err.code] ?? 400;
    sendJSON(res, status, { error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof AppError) {
    sendJSON(res, err.status ?? 400, { error: { code: err.code ?? 'VALIDATION_FAILED', message: err.message } });
    return;
  }
  sendJSON(res, 500, { error: { code: 'DOCS_FAILED', message: 'document request failed' } });
}

const FAIL = {
  INVALID_ROOT: 400, INVALID_PROJECT_ID: 400, INVALID_FOLDER: 400, RESERVED_FOLDER: 400,
  UNSAFE_PATH: 400, TOO_LARGE: 413, TOO_MANY_PROJECTS: 409,
  PROJECT_NOT_REGISTERED: 404,
};

export function invalid(res, message) {
  sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message } });
  return true;
}

/** A JSON object body, or null when the body is missing, not JSON, or not an object. */
export async function objectBody(req) {
  const body = parseJSON(await readBody(req, DOCS_BODY_LIMIT));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

export async function handleProjectRegister(req, res, ctx) {
  const { userId, url, dir } = ctx;
  const dataDir = typeof dir === 'string' && dir ? dir : (config.dataDir ?? nodePath.dirname(config.dbPath));
  const path = new URL(url, 'http://127.0.0.1').pathname;
  if (path !== REGISTER) return false;
  if (req.method !== 'POST') return false;
  try {
    const body = await objectBody(req);
    if (!body) return invalid(res, 'body must be a JSON object { id, root, name? }');
    // R-021 #4: the SERVER chooses a new project's id (a client-supplied one is ignored, so it cannot be
    // pre-claimed with another root). A root that is already registered keeps its server-issued id.
    const db = getDb();
    const id = projectIdForRoot(db, body.root) ?? randomUUID();
    const stored = registerProjectRoot(userId, { id, root: body.root });
    // ADR 0022: the per-user Doc Gen map stays as it was; the canonical registry row is team-wide.
    // A viewer opening an existing project may register their own folder mapping but never rewrite
    // the project's root/name; a new project's registrar becomes its project owner.
    let canonical = getProject(db, stored.id);
    if (!canonical || canManageProject(db, userId, stored.id)) {
      const registered = registerProject(db, userId, { id: stored.id, root: stored.root, name: body.name });
      canonical = registered.project;
      // R-020 #6: team.yaml is authoritative once it has a projects: section, so a new registration is written
      // through at once (as membership changes are); a failed write rolls the project and its owner row back.
      if (registered.created) {
        try {
          persistTeamYaml(db, dataDir, { trigger: 'project.register' });
        } catch {
          db.transaction(() => {
            db.prepare('DELETE FROM project_members WHERE project_id = ?').run(stored.id);
            db.prepare('DELETE FROM projects WHERE id = ?').run(stored.id);
          })();
          return fail(res, 500, 'INTERNAL_ERROR', 'Could not write team.yaml; the project registration was rolled back');
        }
      }
    }
    sendJSON(res, 200, { id: stored.id, root: stored.root, name: canonical?.name ?? null });
  } catch (err) {
    fail(res, err);
  }
  return true;
}
