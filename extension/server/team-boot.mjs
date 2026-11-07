// Boot application of <data dir>/team.yaml (ADR 0021 H1.1).
//
// `kb/team-yaml.mjs` owns the parser, serializer and the single DB application.
// This adapter supplies the audit sink the kb layer may not import (kb → core/kb
// only) and turns the one failure mode into a clear boot log. The caller
// (`server.mjs`) refuses the boot on a thrown `TEAM_YAML_INVALID`.
import path from 'node:path';
import { applyTeamYaml, TEAM_YAML_FILENAME } from '../kb/team-yaml.mjs';
import { safeAudit } from './route-http.mjs';

export const TEAM_YAML_ACTOR = 'team.yaml';

/** The existing audit helper, tagged with the file actor. Never throws. */
function teamYamlAudit(db) {
  return (entry) => safeAudit(db, {
    userId: entry.userId ?? null,
    requestId: TEAM_YAML_ACTOR,
    // The actor is a local file, not a request: keep a clear marker in both
    // places an operator reads, and repeat it in the redacted detail.
    ip: 'boot',
    userAgent: TEAM_YAML_ACTOR,
    action: entry.action,
    resource: entry.resource ?? null,
    outcome: entry.outcome ?? 'success',
    detail: { actor: TEAM_YAML_ACTOR, ...(entry.detail ?? {}) },
  });
}

/**
 * Apply team.yaml once, after migrations and before any request is handled.
 * Returns the apply result for the boot log.
 */
export function applyTeamYamlAtBoot({ db, dir, logger }) {
  try {
    const result = applyTeamYaml(db, dir, { logger, audit: teamYamlAudit(db) });
    // A fresh install with no real accounts yet: nothing was applied and no file was written. The kb
    // module already logged `team_yaml_deferred`; the next boot that sees an account generates the file.
    if (result.deferred) return result;
    logger?.info?.('team_yaml_applied', {
      path: result.path,
      source: result.source,
      created: result.created,
      users: result.users,
      changes: result.changes.length,
      unknownEmails: result.unknownEmails.length,
    });
    return result;
  } catch (err) {
    if (err?.code === 'TEAM_YAML_INVALID') {
      logger?.error?.('team_yaml_invalid', {
        path: path.join(dir, TEAM_YAML_FILENAME),
        reason: err.reason ?? 'invalid',
        line: err.line ?? null,
        message: `${err.message} — refusing to start rather than serve with stale or wider grants (fail closed).`,
      });
    }
    throw err;
  }
}
