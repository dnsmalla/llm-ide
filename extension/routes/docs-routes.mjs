// docs-kit K1 routes: Doc Gen templates, commands and seeding, plus the
// project-id registration they depend on. Owned by the doc_gen feature: the
// group in routes/feature-routes.mjs lists these prefixes, so with doc_gen off
// they answer 404 feature_disabled before this module is reached.
//
// Every route addresses a project by id (`?project=<id>`), never by a path.
// The folder is resolved per user (kb/project-roots.mjs), so another user's
// id is simply unknown. Folder names in the path are checked by
// kb/doc-project-files.mjs (assertFolderName) before any disk access.
//
//   POST   /kb/projects/register                 { id, root }
//   GET    /kb/docs/templates?project=<id>       { templates, count }
//   GET    /kb/docs/commands?project=<id>        { commands, count }
//   PUT    /kb/docs/templates/:folder?project=   { name, sections?, surface?, rawContent?, rewrite? } -> { template }
//   DELETE /kb/docs/templates/:folder?project=   -> { deleted }
//   PUT    /kb/docs/commands/:folder?project=    { name, instruction?, surface?, rawContent? } -> { command }
//   DELETE /kb/docs/commands/:folder?project=    -> { deleted }
//   POST   /kb/docs/seed?project=                kit defaults, write-if-absent -> { written, count }
//
// handleDocsRoutes(req, res, ctx) -> boolean, ctx = { userId, url }.

import { AppError } from '../core/errors.mjs';
import { readBody, parseJSON, sendJSON } from '../core/utils.mjs';
import { listGenerationLibrary } from '../llm_agent/skills/generation-library.mjs';
import {
  DocFilesError, deleteFolder, scanCommands, scanTemplates,
  seedProjectFiles, writeCommand, writeTemplate,
} from '../kb/doc-project-files.mjs';
import { SURFACES } from '../kb/doc-templates.mjs';
import { PROJECT_ID_RE, registerProjectRoot, resolveProjectRoot } from '../kb/project-roots.mjs';

const REGISTER = '/kb/projects/register';
const DOCS = '/kb/docs/';
const ITEM_RE = /^\/kb\/docs\/(templates|commands)\/([^/]+)$/;

/** Upper bound for a request body; the template file itself is capped in doc-project-files. */
export const DOCS_BODY_LIMIT = 512 * 1024;
const MAX_NAME = 200;
const MAX_SECTIONS = 100;
const MAX_SECTION = 200;
const MAX_INSTRUCTION = 20_000;

const FAIL = {
  INVALID_ROOT: 400, INVALID_PROJECT_ID: 400, INVALID_FOLDER: 400, RESERVED_FOLDER: 400,
  NOT_A_PROJECT: 400, UNSAFE_PATH: 400, TOO_LARGE: 413,
  ROOT_NOT_FOUND: 404, PROJECT_NOT_REGISTERED: 404,
};

function fail(res, err) {
  if (err instanceof DocFilesError) {
    sendJSON(res, FAIL[err.code] ?? 400, { error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof AppError) {
    sendJSON(res, err.status ?? 400, { error: { code: err.code ?? 'VALIDATION_FAILED', message: err.message } });
    return;
  }
  sendJSON(res, 500, { error: { code: 'DOCS_FAILED', message: 'document request failed' } });
}

function invalid(res, message) {
  sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message } });
  return true;
}

/** The validated `?project=` id, or null (the caller answers 400). */
function projectParam(url) {
  const id = new URL(url, 'http://127.0.0.1').searchParams.get('project');
  return id && PROJECT_ID_RE.test(id) ? id : null;
}

/** A JSON object body, or null when the body is missing, not JSON, or not an object. */
async function objectBody(req) {
  const body = parseJSON(await readBody(req, DOCS_BODY_LIMIT));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

/** Validate the shared fields of a template or command write. Returns an error string or null. */
function checkWriteFields(body, { allowSections }) {
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > MAX_NAME)) {
    return `name must be a string of at most ${MAX_NAME} characters`;
  }
  if (body.surface !== undefined && !SURFACES.includes(body.surface)) {
    return `surface must be one of ${SURFACES.join(', ')}`;
  }
  if (body.rawContent !== undefined && typeof body.rawContent !== 'string') {
    return 'rawContent must be a string';
  }
  if (allowSections && body.sections !== undefined) {
    if (!Array.isArray(body.sections) || body.sections.length > MAX_SECTIONS
        || body.sections.some((s) => typeof s !== 'string' || s.length > MAX_SECTION)) {
      return `sections must be at most ${MAX_SECTIONS} strings of at most ${MAX_SECTION} characters`;
    }
  }
  if (body.instruction !== undefined && (typeof body.instruction !== 'string' || body.instruction.length > MAX_INSTRUCTION)) {
    return `instruction must be a string of at most ${MAX_INSTRUCTION} characters`;
  }
  return null;
}

/**
 * Handles the docs-kit routes. Returns false for a path it does not own, so
 * the caller can keep dispatching.
 */
export async function handleDocsRoutes(req, res, ctx) {
  const { userId, url } = ctx;
  const path = new URL(url, 'http://127.0.0.1').pathname;

  if (path === REGISTER) {
    if (req.method !== 'POST') return false;
    try {
      const body = await objectBody(req);
      if (!body) return invalid(res, 'body must be a JSON object { id, root }');
      sendJSON(res, 200, registerProjectRoot(userId, { id: body.id, root: body.root }));
    } catch (err) {
      fail(res, err);
    }
    return true;
  }

  if (!path.startsWith(DOCS)) return false;

  // Collection and seed routes.
  if (path === '/kb/docs/templates' && req.method === 'GET') {
    return withProject(req, res, url, userId, (root) => {
      const templates = scanTemplates(root);
      sendJSON(res, 200, { templates, count: templates.length });
    });
  }
  if (path === '/kb/docs/commands' && req.method === 'GET') {
    return withProject(req, res, url, userId, (root) => {
      const commands = scanCommands(root);
      sendJSON(res, 200, { commands, count: commands.length });
    });
  }
  if (path === '/kb/docs/seed' && req.method === 'POST') {
    return withProject(req, res, url, userId, (root) => {
      // The kit is read server-side from the same generation library the Mac
      // menus show (kb/… via llm_agent/skills/generation-library.mjs), so the
      // request carries no file list and no path.
      const kit = listGenerationLibrary(userId);
      const written = seedProjectFiles(root, kit);
      sendJSON(res, 200, { written, count: written.length });
    });
  }

  const item = ITEM_RE.exec(path);
  if (!item) {
    if (path.startsWith(DOCS) && ['templates', 'commands', 'seed'].some((s) => path.startsWith(DOCS + s))) {
      sendJSON(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed on this docs route' } });
      return true;
    }
    return false;
  }

  const [, family, rawFolder] = item;
  let folder;
  try {
    folder = decodeURIComponent(rawFolder);
  } catch {
    return invalid(res, 'folder name is not valid percent-encoding');
  }
  const isTemplate = family === 'templates';

  if (req.method === 'DELETE') {
    return withProject(req, res, url, userId, (root) => {
      const deleted = deleteFolder(root, family, folder);
      if (!deleted) {
        sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: `no ${isTemplate ? 'template' : 'command'} "${folder}"` } });
        return;
      }
      sendJSON(res, 200, { deleted: true, folderName: folder });
    });
  }

  if (req.method === 'PUT') {
    let body;
    try {
      body = await objectBody(req);
    } catch (err) {
      fail(res, err);
      return true;
    }
    if (!body) return invalid(res, 'body must be a JSON object');
    const problem = checkWriteFields(body, { allowSections: isTemplate });
    if (problem) return invalid(res, problem);
    return withProject(req, res, url, userId, (root) => {
      const name = body.name?.trim() || folder;
      if (isTemplate) {
        const template = writeTemplate(root, folder, {
          name, sections: body.sections, surface: body.surface,
          rawContent: body.rawContent, rewrite: body.rewrite === true,
        });
        sendJSON(res, 200, { template });
      } else {
        const command = writeCommand(root, folder, {
          name, instruction: body.instruction, surface: body.surface, rawContent: body.rawContent,
        });
        sendJSON(res, 200, { command });
      }
    });
  }

  sendJSON(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed on this docs route' } });
  return true;
}

/**
 * Resolve `?project=` for this user, then run `fn(root)`. Every failure is
 * answered here, so a route body only does its work.
 */
function withProject(req, res, url, userId, fn) {
  const projectId = projectParam(url);
  if (!projectId) {
    return invalid(res, 'project query parameter is required (a registered project id)');
  }
  try {
    const root = resolveProjectRoot(userId, projectId);
    fn(root);
  } catch (err) {
    fail(res, err);
  }
  return true;
}
