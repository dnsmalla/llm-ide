// Composes the role/persona BASE for the global agent.
// Lean by design: role prompt only. NO agentContext — that's internal's job
// (see compose-prompt.mjs under internal/). Touching this file to add
// app-specific context would defeat the point of the split.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLE_PROMPT_PATH = join(__dirname, 'prompt.md');

const rolePrompt = readFileSync(ROLE_PROMPT_PATH, 'utf8').trim();

// Returns the global agent's role BASE only — not the skill bodies. The loop's
// buildSystemPrompt renders "# Available skills" + bodies exactly once (it
// already holds the skills map for dispatch), so embedding them here too would
// send every global prompt's skills twice. This mirrors the internal agent,
// whose base is role + _base.md with skills rendered by the loop. The role
// prompt (prompt.md) already explains the fence protocol and the ask-internal /
// update-file contract inline, so the base is self-contained.
export function composeGlobalPrompt() {
  return rolePrompt;
}
