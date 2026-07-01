// Meeting-agent personas + Ask-the-Agent history.
//
// Per-user multi-persona registry. ONE persona is "active" at any
// time — that's the one the in-meeting agent / /chat / /code-assist
// / /kb/agent/ask all read for voice + focus + auto-dispatch.
//
// Stored as a single JSON blob in user_flags['agent.persona']. The
// new shape is `{ active: id, personas: [{id,name,promptSuffix,
// autoDispatch,createdAt}, …] }`. We accept the old single-persona
// shape on read (lifted into a one-row list with id="default") so
// nobody loses data on first upgrade — the next write persists the
// new shape transparently.
//
// Ask-the-Agent history is the append-only chat transcript that
// powers the Cmd-Shift-A sheet — kept here because it shares the
// same per-user lifecycle as personas (rather than living with the
// meeting/source/plan domain).
//
// Extracted from kb/db.mjs as part of the modularization sweep.
// db.mjs re-exports every public function so existing callers
// (`kb.getAgentPersona(...)`) keep working unchanged.

import { getDb, lazyPrepare, requireUser } from './db.mjs';
import { randomBytes } from 'node:crypto';

// ── Persona limits ────────────────────────────────────────────────

const PERSONA_NAME_MAX   = 200;
const PERSONA_SUFFIX_MAX = 8000;
const PERSONA_MAX_COUNT  = 10;

function genPersonaId() {
  // 12 bytes of CSPRNG → 24 hex chars. Short enough for URL paths, and
  // cryptographically random so persona IDs appearing in PUT/DELETE URLs
  // cannot be guessed even by a user who has seen their own IDs.
  // Math.random() was replaced: it is not cryptographically secure and
  // enabled IDOR attacks against other users' personas.
  return randomBytes(12).toString('hex');
}

function readPersonaBlob(db, userId) {
  const row = lazyPrepare(db,
    "SELECT value FROM user_flags WHERE user_id = ? AND flag = 'agent.persona'",
  ).get(userId);
  if (!row?.value) return { active: null, personas: [] };
  try {
    const parsed = JSON.parse(row.value);
    // New multi-persona shape.
    if (Array.isArray(parsed.personas)) {
      const personas = parsed.personas
        .filter((p) => p && typeof p.id === 'string')
        .map((p) => ({
          id: p.id,
          name: typeof p.name === 'string' ? p.name : null,
          promptSuffix: typeof p.promptSuffix === 'string' ? p.promptSuffix : null,
          autoDispatch: p.autoDispatch === true,
          // Accept both legacy Unix-epoch (number) and new ISO string.
          createdAt: p.createdAt ?? new Date().toISOString(),
        }));
      const active = typeof parsed.active === 'string'
        && personas.some((p) => p.id === parsed.active)
        ? parsed.active
        : personas[0]?.id ?? null;
      return { active, personas };
    }
    // Legacy single-persona shape — lift into a one-row list.
    if (typeof parsed.name === 'string' || typeof parsed.promptSuffix === 'string') {
      const legacy = {
        id: 'default',
        name: typeof parsed.name === 'string' ? parsed.name : null,
        promptSuffix: typeof parsed.promptSuffix === 'string' ? parsed.promptSuffix : null,
        autoDispatch: parsed.autoDispatch === true,
        createdAt: new Date().toISOString(),
      };
      return { active: 'default', personas: [legacy] };
    }
  } catch {
    // Corrupted blob — treat as no personas rather than throwing.
  }
  return { active: null, personas: [] };
}

function writePersonaBlob(db, userId, blob) {
  if (!blob || blob.personas.length === 0) {
    lazyPrepare(db, "DELETE FROM user_flags WHERE user_id = ? AND flag = 'agent.persona'").run(userId);
    return;
  }
  const value = JSON.stringify({
    active: blob.active,
    personas: blob.personas,
  });
  lazyPrepare(db, `
    INSERT INTO user_flags (user_id, flag, value)
    VALUES (?, 'agent.persona', ?)
    ON CONFLICT(user_id, flag) DO UPDATE SET
      value  = excluded.value,
      set_at = datetime('now')
  `).run(userId, value);
}

/// Returns the user's currently-active persona. Contract preserved
/// from the single-persona era so /chat, /code-assist, /kb/agent/ask,
/// and the meeting-agent loop all keep working without changes.
/// Returns null when no persona exists (defaults apply).
export function getAgentPersona(userId) {
  requireUser(userId);
  const db = getDb();
  const blob = readPersonaBlob(db, userId);
  if (!blob.active) return null;
  const p = blob.personas.find((x) => x.id === blob.active);
  if (!p) return null;
  return {
    name: p.name,
    promptSuffix: p.promptSuffix,
    autoDispatch: p.autoDispatch,
  };
}

/// Legacy single-persona setter — updates the active persona's
/// fields in-place when one exists, OR creates an initial "default"
/// persona when the user has none yet. The Mac client's existing
/// Save button calls this; the multi-persona endpoints below cover
/// list/create/delete/set-active.
export function setAgentPersona(userId, { name, promptSuffix, autoDispatch } = {}) {
  requireUser(userId);
  const cleanName = typeof name === 'string' ? name.trim().slice(0, PERSONA_NAME_MAX) : '';
  const cleanSuffix = typeof promptSuffix === 'string' ? promptSuffix.trim().slice(0, PERSONA_SUFFIX_MAX) : '';
  const cleanAuto = autoDispatch === true;
  const db = getDb();
  // Wrap read+write in a transaction — concurrent requests (e.g. two
  // concurrent PUT /kb/agent/persona calls) otherwise race on the
  // JSON blob and the last writer silently wins.
  return db.transaction(() => {
    const blob = readPersonaBlob(db, userId);

    // Reset semantics: when the user clears everything AND there's only
    // a single persona row, delete the flag so defaults apply (matches
    // the single-persona era's behavior).
    if (!cleanName && !cleanSuffix && !cleanAuto && blob.personas.length <= 1) {
      writePersonaBlob(db, userId, { active: null, personas: [] });
      return null;
    }

    if (blob.active) {
      blob.personas = blob.personas.map((p) =>
        p.id === blob.active
          ? { ...p, name: cleanName || null, promptSuffix: cleanSuffix || null, autoDispatch: cleanAuto }
          : p,
      );
    } else {
      // No personas yet — bootstrap a "default" so the save sticks.
      const id = 'default';
      blob.personas = [{
        id, name: cleanName || null, promptSuffix: cleanSuffix || null,
        autoDispatch: cleanAuto, createdAt: new Date().toISOString(),
      }];
      blob.active = id;
    }
    writePersonaBlob(db, userId, blob);
    return { name: cleanName || null, promptSuffix: cleanSuffix || null, autoDispatch: cleanAuto };
  })();
}

/// List every persona this user has. The active id is returned
/// alongside so the UI can show a radio without a second call.
export function listAgentPersonas(userId) {
  requireUser(userId);
  const db = getDb();
  const blob = readPersonaBlob(db, userId);
  return { personas: blob.personas, active: blob.active, count: blob.personas.length };
}

/// Create a new persona. If this is the user's first one it
/// becomes active automatically. Caps at PERSONA_MAX_COUNT so a
/// runaway client can't blow up the JSON blob.
export function createAgentPersona(userId, { name, promptSuffix, autoDispatch } = {}) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const blob = readPersonaBlob(db, userId);
    if (blob.personas.length >= PERSONA_MAX_COUNT) {
      throw new Error(`persona limit reached (${PERSONA_MAX_COUNT})`);
    }
    const persona = {
      id: genPersonaId(),
      name: typeof name === 'string' ? name.trim().slice(0, PERSONA_NAME_MAX) || null : null,
      promptSuffix: typeof promptSuffix === 'string' ? promptSuffix.trim().slice(0, PERSONA_SUFFIX_MAX) || null : null,
      autoDispatch: autoDispatch === true,
      createdAt: new Date().toISOString(),
    };
    blob.personas.push(persona);
    if (!blob.active) blob.active = persona.id;
    writePersonaBlob(db, userId, blob);
    return persona;
  })();
}

/// Update a specific persona by id. Fields are PATCH-style — only
/// the keys present in the body are touched. Returns the updated
/// persona, or null when the id doesn't exist for this user.
export function updateAgentPersona(userId, personaId, patch = {}) {
  requireUser(userId);
  if (typeof personaId !== 'string' || !personaId) return null;
  const db = getDb();
  return db.transaction(() => {
    const blob = readPersonaBlob(db, userId);
    const idx = blob.personas.findIndex((p) => p.id === personaId);
    if (idx < 0) return null;
    const current = blob.personas[idx];
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      next.name = typeof patch.name === 'string' ? patch.name.trim().slice(0, PERSONA_NAME_MAX) || null : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'promptSuffix')) {
      next.promptSuffix = typeof patch.promptSuffix === 'string' ? patch.promptSuffix.trim().slice(0, PERSONA_SUFFIX_MAX) || null : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'autoDispatch')) {
      next.autoDispatch = patch.autoDispatch === true;
    }
    blob.personas[idx] = next;
    writePersonaBlob(db, userId, blob);
    return next;
  })();
}

/// Delete a persona by id. Refuses to delete the LAST persona —
/// users would lose all customization with a misclick. To "reset"
/// to defaults, the single-persona setAgentPersona() with empty
/// fields still works (deletes the row). If the deleted persona was
/// active, the next-most-recently-created one becomes active.
export function deleteAgentPersona(userId, personaId) {
  requireUser(userId);
  if (typeof personaId !== 'string' || !personaId) return { removed: false };
  const db = getDb();
  return db.transaction(() => {
    const blob = readPersonaBlob(db, userId);
    if (blob.personas.length <= 1) {
      throw new Error('cannot delete the only persona; use setAgentPersona with empty fields to reset to defaults');
    }
    const idx = blob.personas.findIndex((p) => p.id === personaId);
    if (idx < 0) return { removed: false };
    blob.personas.splice(idx, 1);
    if (blob.active === personaId) {
      // Promote the most recent surviving persona (createdAt may be ISO or epoch).
      blob.active = blob.personas
        .slice()
        .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))[0].id;
    }
    writePersonaBlob(db, userId, blob);
    return { removed: true, active: blob.active };
  })();
}

/// Switch which persona is active. Returns the new active id, or
/// null when the id doesn't exist for this user.
export function setActiveAgentPersona(userId, personaId) {
  requireUser(userId);
  if (typeof personaId !== 'string' || !personaId) return null;
  const db = getDb();
  return db.transaction(() => {
    const blob = readPersonaBlob(db, userId);
    if (!blob.personas.some((p) => p.id === personaId)) return null;
    blob.active = personaId;
    writePersonaBlob(db, userId, blob);
    return personaId;
  })();
}

// ── Ask-the-Agent history ─────────────────────────────────────────
// Append-only per-user chat transcript. Single-table schema in
// migrations/0007_agent_ask_history.sql.

const ASK_CONTENT_MAX = 16_000;
const ASK_DEFAULT_LIMIT = 50;
const ASK_HARD_LIMIT    = 500;

export function appendAgentAskMessage(userId, { role, content }) {
  requireUser(userId);
  if (role !== 'user' && role !== 'assistant') {
    throw new Error("role must be 'user' or 'assistant'");
  }
  const text = String(content || '').slice(0, ASK_CONTENT_MAX);
  if (!text) throw new Error('content is required');
  const db = getDb();
  // Per-user monotonically increasing seq via subselect+1. Wrapped in
  // a transaction so a concurrent insert can't produce duplicate
  // (user_id, seq) keys. better-sqlite3 is single-process serial
  // already, but the .transaction wrapper is cheap and makes the
  // intent explicit.
  //
  // We also prune the oldest rows INSIDE the same transaction to keep
  // the table bounded. Without pruning, a prolific user accumulates
  // rows indefinitely; listAgentAskMessages caps reads at ASK_HARD_LIMIT
  // but old rows still consume disk and slow COUNT queries.
  const tx = db.transaction((uid, r, c) => {
    const nextSeq = (lazyPrepare(db,
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_ask_messages WHERE user_id = ?',
    ).get(uid)?.next) ?? 1;
    lazyPrepare(db, `
      INSERT INTO agent_ask_messages (user_id, seq, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uid, nextSeq, r, c, Date.now() / 1000);

    // Prune: keep the newest ASK_HARD_LIMIT rows, delete the rest.
    // The subquery finds the lowest seq still in the kept window.
    lazyPrepare(db, `
      DELETE FROM agent_ask_messages
       WHERE user_id = ?
         AND seq < (
           SELECT seq FROM agent_ask_messages
            WHERE user_id = ?
            ORDER BY seq DESC
            LIMIT 1 OFFSET ?
         )
    `).run(uid, uid, ASK_HARD_LIMIT - 1);

    return nextSeq;
  });
  return tx(userId, role, text);
}

export function listAgentAskMessages(userId, { limit } = {}) {
  requireUser(userId);
  const cap = Math.min(
    Math.max(Number.isFinite(limit) ? Number(limit) : ASK_DEFAULT_LIMIT, 1),
    ASK_HARD_LIMIT,
  );
  const db = getDb();
  // Read newest N rows then reverse — gives the sheet a chronological
  // window bounded regardless of how long the user's history grew.
  // Older rows aren't visible but stay in DB until clear.
  const rows = lazyPrepare(db, `
    SELECT seq, role, content, created_at
      FROM agent_ask_messages
     WHERE user_id = ?
     ORDER BY seq DESC
     LIMIT ?
  `).all(userId, cap);
  return rows.reverse();
}

export function clearAgentAskMessages(userId) {
  requireUser(userId);
  const db = getDb();
  const result = lazyPrepare(db,
    'DELETE FROM agent_ask_messages WHERE user_id = ?',
  ).run(userId);
  return { removed: result.changes };
}
