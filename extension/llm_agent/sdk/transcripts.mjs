// SDK transcript disk-layout knowledge — part of the Claude linker
// (docs/explanation/claude-linker.md). The Agent SDK stores per-session
// JSONL transcripts under <config dir>/projects/<encoded-workspace>/;
// where that config dir lives (per-user engine home vs the operator's
// CLAUDE_CONFIG_DIR / ~/.claude) is an SDK implementation detail, so the
// route layer must never encode it — it calls deleteSdkTranscripts and
// stays ignorant of the layout.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentSdkHomeFor } from './engine.mjs';

// Best-effort SDK transcript cleanup. KEYED turns run under the per-user
// CLAUDE_CONFIG_DIR (agentSdkHomeFor); AMBIENT turns run under the
// operator's default config dir (env CLAUDE_CONFIG_DIR, or ~/.claude) —
// redirecting them would hide the operator's login. Whether a given chat's
// turns were keyed can change over its lifetime, so cleanup scans BOTH
// roots; matching is by the chat's unique sdk session id, so scanning the
// operator dir can only ever remove this chat's own files. Pure fs — never
// a shell call — and silent on any failure (no engine home for the user,
// projects dir missing, unreadable entries): transcript cleanup must never
// fail the mapping delete it follows.
export function deleteSdkTranscripts(userId, sdkSessionId) {
  // Matching is by `includes(sdkSessionId)`, and the ambient root is the
  // operator's REAL config dir — a degenerate needle (short/garbage id)
  // could wipe unrelated transcripts, so anything that doesn't look like an
  // SDK session id (UUID-shaped, server-recorded) deletes nothing at all.
  if (typeof sdkSessionId !== 'string' || !/^[0-9a-fA-F-]{16,}$/.test(sdkSessionId)) return;
  const ambientRoot = process.env.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');
  // Directory-level recursive rm stays confined to the server-owned per-user
  // home; inside the operator's dir only per-file transcript matches go.
  const perUserHome = agentSdkHomeFor(userId);
  if (perUserHome) deleteTranscriptsUnder(perUserHome, sdkSessionId, { allowDirRm: true });
  deleteTranscriptsUnder(ambientRoot, sdkSessionId, { allowDirRm: false });
}

function deleteTranscriptsUnder(root, sdkSessionId, { allowDirRm }) {
  const projectsDir = path.join(root, 'projects');
  let workspaces;
  try {
    workspaces = fs.readdirSync(projectsDir);
  } catch {
    return; // no projects dir — nothing to clean
  }
  for (const name of workspaces) {
    const entryPath = path.join(projectsDir, name);
    if (allowDirRm && name.includes(sdkSessionId)) {
      try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch { /* best effort */ }
      continue;
    }
    // Transcripts live one level down, inside the encoded workspace dirs.
    let files;
    try {
      files = fs.readdirSync(entryPath);
    } catch {
      continue; // not a directory / unreadable
    }
    for (const file of files) {
      if (!file.includes(sdkSessionId)) continue;
      try { fs.rmSync(path.join(entryPath, file), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
