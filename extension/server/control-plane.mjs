export function buildHealthPayload({
  dbOk,
  claude,
  migration,
  apiVersion,
  endpoints,
  serverStartedAt,
}) {
  return {
    status: dbOk && claude?.ok ? 'ok' : 'degraded',
    apiVersion,
    schemaVersion: migration?.current ?? 0,
    uptimeSec: Math.round((Date.now() - serverStartedAt) / 1000),
    endpoints,
    checks: {
      db: dbOk,
      claude: !!claude?.ok,
      claudeError: claude?.ok ? undefined : claude?.error,
    },
  };
}

export function buildNotFoundDetails(endpoints) {
  return {
    hint: 'Restart node server.mjs if the client was updated recently.',
    endpoints,
  };
}
