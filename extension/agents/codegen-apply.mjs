// Phase 6 — actually write codegen output to disk.  Always under a
// per-task subdirectory so a generated change can be diffed/reviewed
// before being merged into the user's main branch.  The repo path MUST
// have already been validated against the allowlist by the guardrail
// engine; we re-check here as a defense-in-depth.

import fs from 'fs';
import path from 'path';

const SUBDIR = '.llmide-auto';

function isWithinAllowlist(repoPath, allowedRepos) {
  const abs = path.resolve(repoPath);
  return allowedRepos.some((root) => {
    const r = path.resolve(String(root)).replace(/\/+$/, '');
    return abs === r || abs.startsWith(r + path.sep);
  });
}

function safeJoin(root, relPath) {
  // Reject absolute paths, parent-traversal, NUL bytes, and leading
  // tildes at write time too.  String-level checks first so we never
  // even attempt fs.realpath on something obviously hostile.
  if (typeof relPath !== 'string'
      || relPath.length === 0
      || relPath.length > 1024
      || relPath.includes('\0')
      || path.isAbsolute(relPath)
      || relPath.split(/[/\\]/).includes('..')
      || relPath.startsWith('~')) {
    throw new Error(`Refusing to write path that escapes repo: ${relPath}`);
  }
  const target = path.resolve(root, relPath);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    throw new Error(`Path resolves outside repo: ${relPath}`);
  }
  return target;
}

// Verify that no component along the target path is a symlink pointing
// outside the per-task base directory.  Required because path.resolve()
// is purely lexical — if `<baseDir>/foo` already exists as a symlink to
// /etc/, writing `foo/bar.txt` would create /etc/bar.txt.  We walk the
// path top-down, lstat each existing segment, and reject if any is a
// symlink whose realpath leaves the base.  Run BEFORE writing.
function assertNoSymlinkEscape(baseDir, target) {
  // Resolve both ends through realpath so an outer symlink (e.g. macOS
  // /tmp → /private/tmp) doesn't produce a false positive.  We start
  // from realBase (which exists because applyCodegen mkdirSync'd it)
  // and walk down each lexical segment of the relative path, lstating
  // each component.  If any existing component is a symlink we reject.
  const realBase = fs.realpathSync(baseDir);
  const lexicalRel = path.relative(path.resolve(baseDir), path.resolve(target));
  if (lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel)) {
    throw new Error(`Refusing write: path resolves outside base: ${target}`);
  }
  const segments = lexicalRel.split(path.sep).filter(Boolean);
  let cursor = realBase;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let st;
    try { st = fs.lstatSync(cursor); } catch { return; }   // doesn't exist yet — safe
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing write: symlink in path under .llmide-auto/: ${cursor}`);
    }
  }
}

export function applyCodegen({ repoPath, taskId, files, tests, allowedRepos }) {
  if (!repoPath) throw new Error('repoPath required');
  const all = [...(files || []), ...(tests || [])];
  if (all.length === 0) throw new Error('No files to apply');
  // `allowedRepos` MUST be the server-derived list (looked up by user_id
  // in the router/guardrail) — never the client-supplied payload field.
  // We re-validate here as defense in depth.
  if (!Array.isArray(allowedRepos) || allowedRepos.length === 0
      || !isWithinAllowlist(repoPath, allowedRepos)) {
    throw new Error('Repo path is not in the user\'s allow-list');
  }
  const safeTask = String(taskId || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
  const baseDir = path.join(path.resolve(repoPath), SUBDIR, safeTask);
  fs.mkdirSync(baseDir, { recursive: true });

  const written = [];
  for (const f of all) {
    const target = safeJoin(baseDir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assertNoSymlinkEscape(baseDir, target);
    // Defense-in-depth: lstat checks the current state.  The O_NOFOLLOW
    // open below is the actual TOCTOU guard — if a symlink is swapped in
    // between this lstat and the open, O_NOFOLLOW makes the kernel reject
    // the open with ELOOP rather than silently following it.
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite an existing symlink at: ${target}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // O_NOFOLLOW: if a symlink is atomically swapped in after the lstat
    // above, the kernel rejects the open with ELOOP instead of writing
    // through it.  Falls back gracefully to writeFileSync on platforms
    // where O_NOFOLLOW is unavailable (Windows).
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    if (noFollow) {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
      let fd;
      try {
        fd = fs.openSync(target, flags);
      } catch (err) {
        throw new Error(`Write rejected — possible symlink at target (${err.code}): ${target}`);
      }
      try { fs.writeSync(fd, String(f.content || ''), 0, 'utf8'); }
      finally { fs.closeSync(fd); }
    } else {
      fs.writeFileSync(target, String(f.content || ''), 'utf8');
    }
    written.push(path.relative(path.resolve(repoPath), target));
  }
  return { baseDir, files: written, count: written.length };
}
