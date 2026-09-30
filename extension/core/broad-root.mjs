// Pure "is this root so broad that allowing it means allowing most of the
// disk?" predicate. Lives in core/ so both kb/ (repo registration) and
// llm_agent/ (read/exec roots) apply ONE breadth rule.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const cmp = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
function canon(p) { try { return realpathSync(p); } catch { return null; } }

export function isTooBroadRoot(real) {
  const home = canon(homedir()) || homedir();
  if (real === '/' || real === home) return true;
  if (cmp(real) === cmp(home)) return true;
  // Reject obvious system trees and depth-1 roots like /Users, /etc, /usr.
  const segs = real.split(sep).filter(Boolean);
  if (segs.length <= 1) return true;
  const top = sep + segs[0];
  if (['/etc', '/usr', '/var', '/bin', '/sbin', '/System', '/Library', '/private', '/opt'].includes(top)
      && segs.length <= 2) return true;
  return false;
}
