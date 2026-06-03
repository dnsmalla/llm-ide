// Composes the system prompt for the global agent.
// Lean by design: role + ask-internal skill body only.
// NO agentContext — that's internal's job (see compose-prompt.mjs
// under internal/). Touching this file to add app-specific context
// would defeat the point of the split.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLE_PROMPT_PATH = join(__dirname, 'prompt.md');

const rolePrompt = readFileSync(ROLE_PROMPT_PATH, 'utf8').trim();

export function composeGlobalPrompt({ skills }) {
  const skillBodies = [...skills.values()].map((s) => s.body).join('\n\n---\n\n');
  return [
    rolePrompt,
    '# Available skills',
    skillBodies,
  ].filter((s) => s && s.length > 0).join('\n\n');
}
