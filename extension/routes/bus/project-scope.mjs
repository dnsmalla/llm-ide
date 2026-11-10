// The one project-root check a bus job and a task route share: resolve the registered project, take its realpath and
// refuse a root outside the user's trusted roots. The caller runs in the returned path, never the raw one, so a symlink
// swapped in after the check is never followed.
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '../../kb/project-roots.mjs';
import { buildTrustedRoots, isWithinRoots, isTooBroadRoot } from '../../llm_agent/tools/handlers/repo-files.mjs';

export function defaultProjectAllowed(userId, root) {
  let real; try { real = fs.realpathSync(root); } catch { return false; }
  if (isTooBroadRoot(real)) return false;
  let trusted = []; try { trusted = buildTrustedRoots(userId) || []; } catch { trusted = []; }
  return isWithinRoots(real, trusted);
}

/**
 * A clone folder inside a checked project root (`repo` is project-relative, e.g. "." or "code/app"). It must
 * realpath to a folder under the project's realpath and pass the same allow-list. Throws `REPO_NOT_ALLOWED`.
 */
export function scopedRepoRoot(userId, projectRoot, repo, { allowed = defaultProjectAllowed } = {}) {
  const refuse = () => Object.assign(new Error('The repository is not inside the project.'), { code: 'REPO_NOT_ALLOWED' });
  if (typeof repo !== 'string' || path.isAbsolute(repo)) throw refuse();
  let top; let real;
  try { top = fs.realpathSync(projectRoot); real = fs.realpathSync(path.resolve(top, repo)); } catch { throw refuse(); }
  if (real !== top && !real.startsWith(top + path.sep)) throw refuse();
  if (!allowed(userId, real)) throw refuse();
  return real;
}

/** Throws `project_not_registered` or `project_not_allowed` (the bus codes); returns the checked realpath. */
export function scopedProjectRoot(userId, projectId, { resolve = resolveProjectRoot, allowed = defaultProjectAllowed } = {}) {
  let root;
  try { root = resolve(userId, projectId); } catch { throw new Error('project_not_registered'); }
  if (root && typeof root === 'object') root = root.root;
  try { root = fs.realpathSync(root); } catch { throw new Error('project_not_allowed'); }
  if (!allowed(userId, root)) throw new Error('project_not_allowed');
  return root;
}
