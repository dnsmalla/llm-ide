import { homedir } from 'node:os';
import { join } from 'node:path';
// Managed dir for cloned skills sources (siblings to plugins/).
export function defaultSourcesDir() {
  const base = process.env.LLMIDE_PLUGIN_DIR
    || (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'llm-ide', 'plugins')
        : join(homedir(), '.local', 'share', 'llm-ide', 'plugins'));
  return join(dirnameOf(base), 'skills-sources');
}
function dirnameOf(p) { return p.split('/').slice(0, -1).join('/') || '/'; }
