// Shell guard for learned knowledge (plan 2026-11-19, self-improvement folder). Edit/Write are refused in
// system/self-improvement/ and a Bash command naming it is always asked about (tools/gates.mjs), but a shell command
// can reach a file without naming it. So every native Bash call is bracketed: the folder of each write root is
// snapshotted before the command and compared after it. A change the app did not make (graphkit/
// self-improvement-folder.mjs noteAppWrite) is put back, and what the command left is kept in
// inbox/from-shell-<date>/ where the user reviews it like knowledge from another project. Nothing is lost either way.
// With the SDK sandbox on, the folder is also denied to Bash by the OS (sandboxOptionFromEnv in engine.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { selfImprovementDir } from '../../graphkit/paths.mjs';
import { INBOX, lastAppWriteAt, sourceName } from '../../graphkit/self-improvement-folder.mjs';

export const SNAPSHOT_MAX_FILES = 400;
export const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

/** rel path → bytes of every regular file under `dir` (symlinks are not followed), or null when too big to keep. */
export function snapshotDir(dir) {
  const out = new Map();
  let bytes = 0;
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { if (!walk(r)) return false; continue; }
      if (!e.isFile()) continue;
      if (out.size >= SNAPSHOT_MAX_FILES) return false;
      let buf;
      try { buf = fs.readFileSync(path.join(dir, r)); } catch { continue; }
      bytes += buf.length;
      if (bytes > SNAPSHOT_MAX_BYTES) return false;
      out.set(r, buf);
    }
    return true;
  };
  return walk('') ? out : null;
}

const same = (a, b) => (a === undefined ? b === undefined : b !== undefined && a.equals(b));

/** Puts `dir` back to `before`; returns the changed rel paths. What the command left goes to inbox/from-shell-<date>/. */
export function restoreDir(dir, before, now = new Date()) {
  const after = snapshotDir(dir) ?? new Map();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((r) => !same(before.get(r), after.get(r))).sort();
  if (changed.length === 0) return [];
  let side = sourceName('from-shell', now);
  for (let k = 2; fs.existsSync(path.join(dir, INBOX, side)); k++) side = `${sourceName('from-shell', now)}-${k}`;
  for (const rel of changed) {
    const abs = path.join(dir, rel);
    const left = after.get(rel);
    if (left !== undefined) {
      const keep = path.join(dir, INBOX, side, rel);
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      fs.writeFileSync(keep, left);
    }
    // Unlink first: a command may have swapped the file for a symlink, and writing through it would land elsewhere.
    try { fs.rmSync(abs, { force: true }); } catch { /* replaced below or gone */ }
    const was = before.get(rel);
    if (was !== undefined) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, was, { flag: 'wx' });
    }
  }
  return changed;
}

/** One guard per turn over the learned folders of `roots`. `before`/`after` take the SDK tool-use id. */
export function createLearnedGuard(roots, { clock = Date.now } = {}) {
  const dirs = [...new Set((Array.isArray(roots) ? roots : []).filter(Boolean).map((r) => selfImprovementDir(r)))];
  const pending = new Map();
  return {
    dirs,
    before(id) {
      const at = clock();
      pending.set(id, { at, snaps: dirs.map((d) => [d, fs.existsSync(d) ? snapshotDir(d) : new Map()]) });
    },
    /** The rel paths put back, per folder; empty when nothing changed (or the app itself wrote meanwhile). */
    after(id) {
      const p = pending.get(id);
      pending.delete(id);
      if (!p) return [];
      const out = [];
      for (const [dir, snap] of p.snaps) {
        if (snap === null || lastAppWriteAt(dir) >= p.at) continue;
        try { for (const rel of restoreDir(dir, snap)) out.push(path.join(path.basename(path.dirname(path.dirname(dir))), 'system', 'self-improvement', rel)); } catch { /* best effort */ }
      }
      return out;
    },
  };
}

/** The guard's own hook entries, so tests and callers can tell them from plugin hooks. */
export const LEARNED_GUARD_HOOKS = new WeakSet();

/** `hooks` with the guard on native Bash (PreToolUse + PostToolUse + PostToolUseFailure). */
export function withLearnedGuard(hooks = {}, guard) {
  if (!guard || guard.dirs.length === 0) return hooks;
  const idOf = (input, toolUseId) => toolUseId ?? input?.tool_use_id ?? 'bash';
  const pre = { matcher: 'Bash', hooks: [async (input, toolUseId) => { guard.before(idOf(input, toolUseId)); return {}; }] };
  const post = (event) => ({
    matcher: 'Bash',
    hooks: [async (input, toolUseId) => {
      const undone = guard.after(idOf(input, toolUseId));
      if (undone.length === 0) return {};
      return { hookSpecificOutput: { hookEventName: event, additionalContext: `LLM-IDE undid this command's changes to system/self-improvement/ (${undone.slice(0, 10).join(', ')}). That folder (memory, lessons, accepted changes) changes only through the app; the command's version was kept in its inbox for the user to review. Do not try again.` } };
    }],
  });
  const postOk = post('PostToolUse');
  const postFail = post('PostToolUseFailure');
  for (const e of [pre, postOk, postFail]) LEARNED_GUARD_HOOKS.add(e);
  return {
    ...hooks,
    PreToolUse: [...(hooks.PreToolUse || []), pre],
    PostToolUse: [...(hooks.PostToolUse || []), postOk],
    PostToolUseFailure: [...(hooks.PostToolUseFailure || []), postFail],
  };
}
