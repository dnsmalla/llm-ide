// The one project-root check a bus job and a task route share: resolve the registered project, take its realpath and
// refuse a root outside the user's trusted roots. The caller runs in the returned path, never the raw one, so a symlink
// swapped in after the check is never followed.
import fs from 'node:fs';
import { resolveProjectRoot } from '../../kb/project-roots.mjs';
import { buildTrustedRoots, isWithinRoots, isTooBroadRoot } from '../../llm_agent/tools/handlers/repo-files.mjs';

export function defaultProjectAllowed(userId, root) {
  let real; try { real = fs.realpathSync(root); } catch { return false; }
  if (isTooBroadRoot(real)) return false;
  let trusted = []; try { trusted = buildTrustedRoots(userId) || []; } catch { trusted = []; }
  return isWithinRoots(real, trusted);
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
