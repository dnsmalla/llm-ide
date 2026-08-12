// Locates the central skills repo (dnsmalla/skills) on disk. Pure path
// resolution — no DB, no network — so it lives in core: the skill library
// (llm_agent/skills), the LLM-sources registry (llm-sources/registry.mjs),
// and project skill installation (kb/install-project-skills.mjs) all need it,
// and none of them may import each other (it used to live in the skill
// library, which made registry.mjs ↔ skill-library.mjs a real import cycle).

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// extension/core/ → up two = repo root (llm-ide/).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function resolveCentralSkillsRepo() {
  const candidates = [];
  if (process.env.SKILLS_REPO) candidates.push(process.env.SKILLS_REPO);
  candidates.push(join(REPO_ROOT, '.skills'));
  candidates.push(join(homedir(), 'skills'));
  candidates.push(join(homedir(), 'Desktop', 'skills'));
  candidates.push(join(homedir(), '.cache', 'dnsmalla-skills'));
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'registry.yaml')) || existsSync(join(c, 'agent-tools'))) return c;
    } catch { /* skip */ }
  }
  return null;
}
