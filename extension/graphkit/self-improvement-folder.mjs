// The self-improvement folder's identity (plan 2026-11-19, phase 5). `<project>/system/self-improvement/manifest.json`
// names the project root the folder belongs to. A folder copied in from another project (its manifest names another
// root) must never steer this project's prompts unreviewed, so before anything reads it its learned files are moved
// into `inbox/<project>-<date>/`, where they wait for an Adopt or Dismiss, and a manifest for this project is written.
// Depends only on paths.mjs, so every reader and writer can call ensureOwnFolder without an import cycle.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectRootOf, selfImprovementDir } from './paths.mjs';

export const MANIFEST = 'manifest.json';
export const INBOX = 'inbox';
/** The learned files a foreign folder may bring; anything else in it is left where it is. */
export const LEARNED_FILES = Object.freeze(['memory.md', 'lessons.json', 'changes.jsonl', 'self-heal.md']);
export const SOURCE_RE = /^[A-Za-z0-9._-]{1,100}$/;

const realOrResolved = (p) => { try { return realpathSync(p); } catch { return p; } };
const samePath = (a, b) => (process.platform === 'linux' ? a === b : String(a).toLowerCase() === String(b).toLowerCase());

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
}

function readManifest(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
    return m && typeof m === 'object' && typeof m.root === 'string' ? m : 'corrupt';
  } catch (e) {
    return e?.code === 'ENOENT' ? null : 'corrupt';
  }
}

/** A folder-name-safe label for an inbox source. */
export function sourceName(projectName, now = new Date()) {
  const base = String(projectName || 'imported').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'imported';
  return `${base}-${now.toISOString().slice(0, 10)}`;
}

/**
 * Makes sure the folder belongs to this project. Missing folder: nothing to do. No manifest (a folder this app made
 * before manifests existed): one is written. A manifest naming another root: its learned files move to the inbox.
 * Best effort: a failure leaves files where they are and returns `{ moved: null, error }`.
 */
export function ensureOwnFolder(root, now = new Date()) {
  const dir = selfImprovementDir(root);
  if (!existsSync(dir)) return { moved: null };
  const project = realOrResolved(projectRootOf(root));
  const own = { format: 1, root: project, projectName: basename(project), createdAt: now.toISOString() };
  try {
    const m = readManifest(dir);
    if (m !== null && m !== 'corrupt' && samePath(m.root, project)) return { moved: null };
    if (m === null || m === 'corrupt') {
      if (m === 'corrupt') renameSync(join(dir, MANIFEST), join(dir, `${MANIFEST}.bak`));
      writeAtomic(join(dir, MANIFEST), `${JSON.stringify(own, null, 2)}\n`);
      return { moved: null };
    }
    let name = sourceName(m.projectName || basename(m.root), now);
    for (let k = 2; existsSync(join(dir, INBOX, name)); k++) name = `${sourceName(m.projectName || basename(m.root), now)}-${k}`;
    const target = join(dir, INBOX, name);
    mkdirSync(target, { recursive: true });
    for (const f of LEARNED_FILES) if (existsSync(join(dir, f))) renameSync(join(dir, f), join(target, f));
    writeAtomic(join(target, MANIFEST), `${JSON.stringify(m, null, 2)}\n`);
    writeAtomic(join(dir, MANIFEST), `${JSON.stringify(own, null, 2)}\n`);
    return { moved: name };
  } catch (error) {
    return { moved: null, error };
  }
}
