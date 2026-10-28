export function buildHealthPayload({
  dbOk,
  claude,
  migration,
  apiVersion,
  endpoints,
  serverStartedAt,
  skillsAvailable,
  features = null,
  storage = null,
}) {
  return {
    status: dbOk && claude?.ok && skillsAvailable !== false ? 'ok' : 'degraded',
    apiVersion,
    schemaVersion: migration?.current ?? 0,
    uptimeSec: Math.round((Date.now() - serverStartedAt) / 1000),
    endpoints,
    // LLMIDE_FEATURES as the server applied it: null = every feature, else the
    // enabled keys, sorted (JSON has no Set; a stable order lets the Mac
    // compare it with the feature set it launched the server with).
    features: features ? [...features].sort() : null,
    // Where the global data lives: 'system' (LLMIDE_DATA_DIR) or 'repo-kb', and
    // the boot migration outcome (kb/data-dir-migration.mjs). No paths here.
    ...(storage ? { storage } : {}),
    checks: {
      db: dbOk,
      claude: !!claude?.ok,
      claudeError: claude?.ok ? undefined : claude?.error,
      // The .skills submodule is the ONLY source of skills now (no
      // fallback copy) — see docs/explanation/invariants.md. false here
      // means Plan/Assist Plan/Execute have no process skill to inject.
      skills: skillsAvailable !== false,
      skillsError: skillsAvailable === false
        ? '.skills is not initialized — run `git submodule update --init .skills` at the repo root, then `bash scripts/install-skills.sh`.'
        : undefined,
    },
  };
}

export function buildNotFoundDetails(endpoints) {
  return {
    hint: 'Restart node server.mjs if the client was updated recently.',
    endpoints,
  };
}
