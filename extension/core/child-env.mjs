// The environment for helper children the server spawns on its own behalf
// (git clone/fetch, npm install, the skills install/sync scripts): the
// server's process.env minus the server's OWN secrets and provider keys.
//
// Those children run third-party code (git hooks/filters, npm lifecycle
// scripts, repo-supplied shell scripts), so they must not inherit
// LLMIDE_JWT_SECRET (signs every session), LLMIDE_VAULT_KEY (decrypts every
// stored key) or the operator's provider credentials. PATH, HOME, proxy and
// locale variables pass through, so git/npm keep working.
//
// Denylist on purpose (see llm_agent/sdk/subprocess-env.mjs for the same
// reasoning); the prefix set is a superset of that one.

const SECRET_PREFIXES = Object.freeze([
  'LLMIDE_', 'MEETNOTES_', 'ANTHROPIC_', 'CLAUDE_CODE_OAUTH', 'OPENAI_', 'GOOGLE_API', 'GEMINI_', 'AWS_SECRET', 'AWS_SESSION',
]);

/**
 * @param {Record<string, string>} [extra] variables to add after scrubbing.
 * @param {Record<string, string|undefined>} [source]
 * @returns {Record<string, string>} a fresh object; `source` is not modified.
 */
export function scrubbedChildEnv(extra = {}, source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const upper = name.toUpperCase();
    if (SECRET_PREFIXES.some((p) => upper.startsWith(p))) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}
