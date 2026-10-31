// Pure "is this root so broad that allowing it means allowing most of the
// disk?" predicate. Lives in core/ so both kb/ (repo registration) and
// llm_agent/ (read/exec roots) apply ONE breadth rule.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const cmp = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
function canon(p) { try { return realpathSync(p); } catch { return null; } }

// Credential and kernel/system trees that are never a project: a root equal to or inside one
// of these is refused. (Kept in step with desktop/src-tauri/src/project.rs `is_too_broad`.)
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg'];          // equal or inside
const SECRET_HOME_EXACT = ['.config'];                        // the container itself only
const SYSTEM_TREES = ['proc', 'dev', 'sys', 'boot'];          // equal or inside
const SYSTEM_EXACT = ['root'];                                // /root itself only

function inSensitiveTree(real, home) {
  const lower = real.replace(/\\/g, '/').split('/').filter(Boolean).map((x) => x.toLowerCase());
  if (lower.length && SYSTEM_TREES.includes(lower[0])) return true;
  if (lower.length === 1 && SYSTEM_EXACT.includes(lower[0])) return true;
  // macOS per-user temp roots: /private/var/folders/xx/yyyy[/T] themselves, not projects inside them.
  if (lower[0] === 'private' && lower[1] === 'var' && lower[2] === 'folders' && lower.length <= 6) return true;
  const h = home.replace(/\\/g, '/').split('/').filter(Boolean).map((x) => x.toLowerCase());
  if (h.length && lower.length > h.length && h.every((seg, i) => seg === lower[i])) {
    const rest = lower.slice(h.length);
    if (SECRET_HOME_DIRS.includes(rest[0])) return true;
    if (rest.length === 1 && SECRET_HOME_EXACT.includes(rest[0])) return true;
  }
  return false;
}

export function isTooBroadRoot(real) {
  const home = canon(homedir()) || homedir();
  if (real === '/' || real === home) return true;
  if (cmp(real) === cmp(home)) return true;
  if (inSensitiveTree(real, home)) return true;
  // Reject obvious system trees and depth-1 roots like /Users, /etc, /usr.
  const segs = real.split(sep).filter(Boolean);
  if (segs.length <= 1) return true;
  const top = sep + segs[0];
  if (['/etc', '/usr', '/var', '/bin', '/sbin', '/System', '/Library', '/private', '/opt'].includes(top)
      && segs.length <= 2) return true;
  return false;
}

// Stricter rule for TRUSTING a folder (PUT /auth/me/workspace-trust): trust is a security grant, so a root that is
// itself a shared or per-user container (a volume, another user's home, a temp dir, Documents/Desktop/Downloads,
// a Windows system or users tree, a UNC share root) must not be grantable. A project INSIDE such a container
// (~/Desktop/LLM, /Volumes/disk/proj) is fine: only the container itself is refused.
const HOME_CONTAINERS = new Set(['documents', 'desktop', 'downloads', 'library', 'movies', 'music', 'pictures', 'public']);
export function isTooBroadTrustRoot(real) {
  if (isTooBroadRoot(real)) return true;
  if (typeof real !== 'string' || !real) return true;
  const w = real.replace(/\\/g, '/');
  if (/^[a-z]:\/?$/i.test(w)) return true;
  if (/^[a-z]:\/(users(\/[^/]+)?|windows(\/.*)?|program files( \(x86\))?|programdata)\/?$/i.test(w)) return true;
  if (/^\/\/[^/]+(\/[^/]+)?\/?$/.test(w)) return true;
  const segs = w.split('/').filter(Boolean);
  const lower = segs.map((s) => s.toLowerCase());
  const top = lower[0];
  if (top === 'system') return true; // /System/**
  if (top === 'volumes' && segs.length <= 2) return true;
  if ((top === 'users' || top === 'home') && segs.length <= 2) return true; // any user's home itself
  const norm = lower.join('/');
  if (['tmp', 'var/tmp', 'private/tmp', 'private/var/tmp'].includes(norm)) return true;
  const home = (canon(homedir()) || homedir()).replace(/\\/g, '/');
  const hp = home.split('/').filter(Boolean).map((s) => s.toLowerCase()).join('/');
  if (hp && norm.startsWith(`${hp}/`)) {
    const rest = norm.slice(hp.length + 1).split('/');
    if (rest.length === 1 && HOME_CONTAINERS.has(rest[0])) return true;
  }
  // Another user's Documents/Desktop/Downloads (/Users/x/Documents, /home/x/Desktop).
  if ((top === 'users' || top === 'home') && segs.length === 3 && HOME_CONTAINERS.has(lower[2])) return true;
  return false;
}
