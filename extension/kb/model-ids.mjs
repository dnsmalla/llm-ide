// Claude model-id normalisation over schema/models/anthropic-models.json.
//
// The catalog's `retired` map names each retired id's successor. Stored rows
// keep whatever id they were written with, so without this a catalog update
// stranded saved limits and quota flags under ids nothing offers any more
// (and a stored retired id could sort ahead of its successor in the chain).
//
// Rules: limits and quota state are keyed by the CANONICAL id; the usage
// ledger keeps the id that actually ran (it is history), and counting for a
// model includes every retired alias of it.

import { readFileSync } from 'node:fs';

export const ANTHROPIC_MODELS = JSON.parse(
  readFileSync(new URL('../../schema/models/anthropic-models.json', import.meta.url), 'utf8'),
);

const RETIRED = ANTHROPIC_MODELS.retired || {};

/** The live id for `model` (follows the retired map; ids it does not name pass through). */
export function canonicalModel(provider, model) {
  if (provider !== 'anthropic' || typeof model !== 'string') return model;
  let id = model;
  // Bounded walk: the catalog forbids chains, but a bad edit must not loop.
  for (let i = 0; i < 8 && Object.hasOwn(RETIRED, id); i += 1) id = RETIRED[id];
  return id;
}

/** `model` plus every retired id that resolves to it — the ids its usage was recorded under. */
export function modelAliases(provider, model) {
  if (provider !== 'anthropic' || typeof model !== 'string') return [model];
  const live = canonicalModel(provider, model);
  const ids = new Set([live]);
  for (const old of Object.keys(RETIRED)) {
    if (canonicalModel(provider, old) === live) ids.add(old);
  }
  return [...ids];
}

/**
 * Migration 0046 data step: re-key saved Anthropic limits to live ids and drop
 * quota flags recorded under retired ids. A user who already has a row for the
 * successor keeps it; the retired row is then removed rather than merged.
 * Idempotent.
 */
export function migrateRetiredModelIds(db) {
  const retiredIds = Object.keys(RETIRED);
  if (!retiredIds.length) return;
  const placeholders = retiredIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT user_id, model FROM model_limits WHERE provider='anthropic' AND model IN (${placeholders})`,
  ).all(...retiredIds);
  const exists = db.prepare(
    "SELECT 1 FROM model_limits WHERE user_id=? AND provider='anthropic' AND model=?",
  );
  const rename = db.prepare(
    "UPDATE model_limits SET model=? WHERE user_id=? AND provider='anthropic' AND model=?",
  );
  const drop = db.prepare(
    "DELETE FROM model_limits WHERE user_id=? AND provider='anthropic' AND model=?",
  );
  for (const r of rows) {
    const live = canonicalModel('anthropic', r.model);
    if (exists.get(r.user_id, live)) drop.run(r.user_id, r.model);
    else rename.run(live, r.user_id, r.model);
  }
  db.prepare(
    `DELETE FROM quota_state WHERE provider='anthropic' AND model IN (${placeholders})`,
  ).run(...retiredIds);
}
