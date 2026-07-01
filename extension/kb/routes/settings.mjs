// Per-user settings sync (cross-machine).
//
//   GET /kb/settings        → { settings: <object> }   (the stored blob, or {})
//   PUT /kb/settings  body:  { settings: <object> }     → { ok: true }
//
// The Mac client stores NON-SECRET config here (saved GitLab/GitHub project
// lists, provider choice, active project) so opening the app on another machine
// restores the same Issues/Gantt view. Access tokens are NEVER sent here — they
// stay in each machine's Keychain. Tenant-scoped via the userId the router
// already authenticated.

import * as kb from '../db.mjs';
import { sendJSON, readBody, parseJSON } from '../../core/utils.mjs';

const MAX_SETTINGS_BYTES = 64 * 1024;

export async function handleSettingsRoutes(req, res, ctx) {
  const { userId, url } = ctx;
  if (new URL(url, 'http://127.0.0.1').pathname !== '/kb/settings') return false;

  if (req.method === 'GET') {
    let settings = {};
    try { settings = JSON.parse(kb.getUserSettings(userId)); } catch { settings = {}; }
    sendJSON(res, 200, { settings });
    return true;
  }

  if (req.method === 'PUT') {
    const body = parseJSON(await readBody(req, MAX_SETTINGS_BYTES)) || {};
    const settings = (body && typeof body.settings === 'object' && body.settings !== null)
      ? body.settings : {};
    const json = JSON.stringify(settings);
    if (json.length > MAX_SETTINGS_BYTES) {
      sendJSON(res, 413, { error: { code: 'SETTINGS_TOO_LARGE', message: 'settings blob too large' } });
      return true;
    }
    kb.setUserSettings(userId, json);
    sendJSON(res, 200, { ok: true });
    return true;
  }

  sendJSON(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET or PUT' } });
  return true;
}
