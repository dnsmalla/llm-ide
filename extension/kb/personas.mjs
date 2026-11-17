// Meeting-agent persona (voice + focus + auto-dispatch), one per user.
//
// The in-meeting agent, /chat and /code-assist read it. The blob may hold a
// list of personas with one active; only the active one is ever read.
//
// Stored as a single JSON blob in user_flags['agent.persona']. The
// new shape is `{ active: id, personas: [{id,name,promptSuffix,
// autoDispatch,createdAt}, …] }`. We accept the old single-persona
// shape on read (lifted into a one-row list with id="default") so
// nobody loses data on first upgrade — the next write persists the
// new shape transparently.
//
//
// Extracted from kb/db.mjs as part of the modularization sweep.
// db.mjs re-exports every public function so existing callers
// (`kb.getAgentPersona(...)`) keep working unchanged.

import { getDb, lazyPrepare, requireUser } from './db.mjs';

// ── Persona limits ────────────────────────────────────────────────

const PERSONA_NAME_MAX   = 200;
const PERSONA_SUFFIX_MAX = 8000;

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
/// from the single-persona era so /chat, /code-assist and the meeting-agent
/// loop keep working without changes.
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
