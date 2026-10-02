// The environment the Agent SDK's CLI subprocess runs with.
//
// The SDK's `env` option REPLACES the subprocess environment, and that
// subprocess is what runs the agent's Bash — so whatever is here, every
// approved command can read. It is the server's process.env minus the
// server's OWN configuration: LLMIDE_JWT_SECRET signs every user's session
// and LLMIDE_VAULT_KEY decrypts every stored API key, and nothing the CLI or
// a command needs lives under those prefixes (the server reads them itself).
//
// Deliberately a denylist, not run-bash's allowlist (buildChildEnv): the CLI
// needs its own auth/config variables (ANTHROPIC_*, CLAUDE_*, cloud-provider
// ones), and the user's calculations and tests need theirs (licence files,
// conda/virtualenv, toolchain paths) — an allowlist would silently strip both.

const SERVER_ENV_PREFIXES = Object.freeze(['LLMIDE_', 'MEETNOTES_']);

/**
 * `source` without the server's own variables.
 *
 * @param {Record<string, string|undefined>} [source]
 * @returns {Record<string, string>} a fresh object; `source` is not modified.
 */
export function sdkSubprocessEnv(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (SERVER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  return env;
}
