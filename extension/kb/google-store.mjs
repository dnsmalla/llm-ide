// Per-user Google connector state: accounts (non-secret) and sync cursors. Tokens are NOT here, they live in the
// vault (server/vault.mjs, key pattern google.acct.<id>.*). Every function takes userId first and scopes by it.
import { getDb, requireUser } from './db.mjs';

const CONNECTORS = new Set(['gmail', 'gcal', 'gdrive', 'ical']);
const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };

function rowToAccount(r) {
  return {
    accountId: r.account_id,
    email: r.email,
    scopes: parseJson(r.scopes, []),
    products: parseJson(r.products, []),
    driveContent: r.drive_content === 1,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function upsertGoogleAccount(userId, { accountId, email, scopes, products, driveContent }) {
  requireUser(userId);
  getDb().prepare(`
    INSERT INTO google_accounts (user_id, account_id, email, scopes, products, drive_content, status)
    VALUES (?, ?, ?, ?, ?, ?, 'connected')
    ON CONFLICT(user_id, account_id) DO UPDATE SET
      email = excluded.email, scopes = excluded.scopes, products = excluded.products,
      drive_content = excluded.drive_content, status = 'connected', updated_at = datetime('now')
  `).run(userId, accountId, String(email || ''), JSON.stringify(scopes || []), JSON.stringify(products || []), driveContent ? 1 : 0);
}

export function getGoogleAccount(userId, accountId) {
  requireUser(userId);
  const r = getDb().prepare('SELECT * FROM google_accounts WHERE user_id = ? AND account_id = ?').get(userId, accountId);
  return r ? rowToAccount(r) : null;
}

export function listGoogleAccounts(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT * FROM google_accounts WHERE user_id = ? ORDER BY created_at, account_id').all(userId).map(rowToAccount);
}

export function setGoogleAccountStatus(userId, accountId, status) {
  requireUser(userId);
  if (status !== 'connected' && status !== 'reconnect_needed') throw new Error('invalid account status');
  getDb().prepare("UPDATE google_accounts SET status = ?, updated_at = datetime('now') WHERE user_id = ? AND account_id = ?")
    .run(status, userId, accountId);
}

export function deleteGoogleAccount(userId, accountId) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const s = db.prepare('DELETE FROM connector_sync_state WHERE user_id = ? AND account_id = ?').run(userId, accountId).changes;
    const a = db.prepare('DELETE FROM google_accounts WHERE user_id = ? AND account_id = ?').run(userId, accountId).changes;
    return { accounts: a, syncStates: s };
  })();
}

function rowToState(r) {
  return {
    connectorId: r.connector_id, accountId: r.account_id,
    cursor: r.cursor ?? null, pendingCursor: r.pending_cursor ?? null,
    options: parseJson(r.options, {}), status: r.status, lastError: r.last_error ?? null, lastRunAt: r.last_run_at ?? null,
  };
}

export function getSyncState(userId, connectorId, accountId) {
  requireUser(userId);
  if (!CONNECTORS.has(connectorId)) throw new Error('unknown connector');
  const r = getDb().prepare('SELECT * FROM connector_sync_state WHERE user_id = ? AND connector_id = ? AND account_id = ?')
    .get(userId, connectorId, accountId);
  return r ? rowToState(r) : { connectorId, accountId, cursor: null, pendingCursor: null, options: {}, status: 'idle', lastError: null, lastRunAt: null };
}

export function listSyncStates(userId, accountId) {
  requireUser(userId);
  return getDb().prepare('SELECT * FROM connector_sync_state WHERE user_id = ? AND account_id = ?').all(userId, accountId).map(rowToState);
}

/** Patch one state row (upsert). Only the keys present in `patch` change. `lastError` is stored truncated. */
export function patchSyncState(userId, connectorId, accountId, patch) {
  requireUser(userId);
  if (!CONNECTORS.has(connectorId)) throw new Error('unknown connector');
  const cur = getSyncState(userId, connectorId, accountId);
  const next = { ...cur, ...patch };
  const err = next.lastError == null ? null : String(next.lastError).slice(0, 300);
  getDb().prepare(`
    INSERT INTO connector_sync_state (user_id, connector_id, account_id, cursor, pending_cursor, options, status, last_error, last_run_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, connector_id, account_id) DO UPDATE SET
      cursor = excluded.cursor, pending_cursor = excluded.pending_cursor, options = excluded.options,
      status = excluded.status, last_error = excluded.last_error, last_run_at = excluded.last_run_at, updated_at = datetime('now')
  `).run(userId, connectorId, accountId, next.cursor, next.pendingCursor, JSON.stringify(next.options || {}), next.status || 'idle', err, next.lastRunAt ?? null);
  return getSyncState(userId, connectorId, accountId);
}
