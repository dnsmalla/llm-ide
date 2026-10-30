// One-time, idempotent, NON-destructive carry-over of the keys a user already stored for the built-in
// providers into the provider catalog (agent-kit K1 Phase 6). The classic engine that ran those keys is
// gone, so without this a user whose only key is DeepSeek would have no chat provider until they
// reconnected it by hand.
//
// For each of: the openai / google / deepseek vault keys, every OpenAI-compatible custom provider the user
// registered (custom:<uuid>) and the shared "custom" endpoint, create the equivalent catalog connection and
// copy the key into the connection's own vault slot. Nothing is deleted or changed: the old keys and
// settings stay. A connection for that catalog entry (or base URL) that already exists is left alone. A
// base URL the guard refuses is skipped and recorded as "needs review" with its reason, shown in the
// Provider catalog card. Failures are per provider, logged with the key redacted, and never block others.
// The outcome is recorded in user_flags `provider.migration.v1`, so it runs once per user.

import { getDb } from '../kb/db.mjs';
import { getSecret } from '../server/vault.mjs';
import { logger } from '../core/logger.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';
import { listCustomProviders } from '../server/custom-providers.mjs';
import { listConnections, connectProvider, getSettings, updateSettings } from '../server/provider-connections.mjs';

const log = logger.child({ component: 'legacy-key-migration' });
const FLAG = 'provider.migration.v1';
const BUILT_IN = [
  { provider: 'openai', catalogId: 'openai', vaultKey: 'openai.apiKey', name: 'OpenAI' },
  { provider: 'google', catalogId: 'google', vaultKey: 'google.apiKey', name: 'Google Gemini' },
  { provider: 'deepseek', catalogId: 'deepseek', vaultKey: 'deepseek.apiKey', name: 'DeepSeek' },
];

function readRecord(db, userId) {
  const row = db.prepare('SELECT value FROM user_flags WHERE user_id = ? AND flag = ?').get(userId, FLAG);
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function writeRecord(db, userId, record) {
  db.prepare(`
    INSERT INTO user_flags (user_id, flag, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, flag) DO UPDATE SET value = excluded.value, set_at = datetime('now')
  `).run(userId, FLAG, JSON.stringify(record));
}

const keyOf = (db, userId, vaultKey) => { try { return getSecret(db, userId, vaultKey) || null; } catch { return null; } };
const slugFor = (id) => `m${String(id).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)}`.slice(0, 24);

/** The public view of a stored record (what GET /kb/providers/catalog returns), or null. */
export function migrationView(record) {
  if (!record) return null;
  return {
    created: (record.created || []).map((c) => ({ provider: c.provider, name: c.name })),
    needsReview: (record.needsReview || []).map((r) => ({ provider: r.provider, name: r.name, reason: r.reason })),
    toolsEnabled: record.toolsEnabled === true,
  };
}

/**
 * Run the migration for `userId` once. Returns the stored record (a second call returns it unchanged).
 * Never throws: a failure of the whole sweep is logged and leaves no record, so it is retried next time.
 */
export function migrateLegacyProviderKeys(userId, { db = getDb() } = {}) {
  if (!userId) return null;
  try {
    const existing = readRecord(db, userId);
    if (existing) return existing;

    const connections = listConnections(userId, db);
    const record = { doneAt: new Date().toISOString(), created: [], needsReview: [], toolsEnabled: false };
    const attempt = (label, { provider, name }, key, run) => {
      try { run(); record.created.push({ provider, name }); }
      catch (err) {
        const reason = redactWithKey(String(err?.message || err), key).slice(0, 200);
        record.needsReview.push({ provider, name, reason });
        log.warn('legacy_key_migration_skipped', { provider: label, reason });
      }
    };

    for (const b of BUILT_IN) {
      const key = keyOf(db, userId, b.vaultKey);
      if (!key) continue;
      if (connections.some((c) => c.catalogId === b.catalogId)) continue;   // the user already connected it
      attempt(b.provider, b, key, () => { connectProvider(userId, { catalogId: b.catalogId, apiKey: key }, db); });
    }

    // OpenAI-compatible custom providers (the Mac's Custom Providers list) and the shared custom endpoint.
    const compat = [];
    for (const cp of listCustomProviders(userId, db)) {
      if (cp.isOpenAICompatible === false || cp.isEnabled === false) continue;
      compat.push({ provider: `custom:${cp.id}`, name: cp.name, baseURL: cp.baseURL, vaultKey: cp.vaultKey, slug: slugFor(cp.id) });
    }
    const sharedUrl = keyOf(db, userId, 'custom.baseUrl');
    if (sharedUrl && keyOf(db, userId, 'custom.apiKey')) {
      compat.push({ provider: 'custom', name: 'Custom endpoint', baseURL: sharedUrl, vaultKey: 'custom.apiKey', slug: 'legacy' });
    }
    for (const c of compat) {
      const key = keyOf(db, userId, c.vaultKey);
      if (!key) continue;
      if (listConnections(userId, db).some((x) => x.catalogId === 'openai-compatible' && x.baseURL.replace(/\/+$/, '') === String(c.baseURL).replace(/\/+$/, ''))) continue;
      attempt(c.provider, c, key, () => {
        connectProvider(userId, { catalogId: 'openai-compatible', apiKey: key, baseURL: c.baseURL, slug: c.slug, name: c.name }, db);
      });
    }

    // Provider chat was available on these keys before (the classic engine ran tools); keep it that way.
    if (record.created.length && !getSettings(userId, db).toolsEnabled) {
      updateSettings(userId, { toolsEnabled: true }, db);
      record.toolsEnabled = true;
    }
    writeRecord(db, userId, record);
    log.info('legacy_key_migration_done', { created: record.created.map((c) => c.provider), needsReview: record.needsReview.map((r) => r.provider) });
    return record;
  } catch (err) {
    log.warn('legacy_key_migration_failed', { message: String(err?.message || err).slice(0, 160) });
    return null;
  }
}

/** The stored record without running anything. */
export function getMigrationRecord(userId, db = getDb()) { return userId ? readRecord(db, userId) : null; }
