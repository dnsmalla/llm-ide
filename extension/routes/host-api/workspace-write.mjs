// Confined writer for Host API `files.write`: the remote client names a path
// relative to the project root, and this module refuses everything outside it.
//
// SECURITY MODEL:
//   - `..`, absolute paths and empty segments are rejected before touching disk.
//   - The nearest existing ancestor is realpath'd BEFORE any folder is created,
//     so a symlinked parent cannot make us create folders outside the project.
//   - The denylist runs on both the lexical path and the realpath'd parent, so
//     an in-project symlink (e.g. `alias -> .git`) cannot smuggle a denied target.
//   - A final symlink or any non-regular file target is refused.
//   - Writes are atomic: sibling temp file opened `wx`, then rename; the temp is
//     unlinked if the rename fails.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeniedPath } from '../../llm_agent/tools/handlers/repo-files.mjs';

export const MAX_TEXT = 262_144;
export const hashBytes = (buf) => createHash('sha256').update(buf).digest('hex');
export const hashText = (text) => hashBytes(Buffer.from(text, 'utf8'));

const fail = (code, message) => Object.assign(new Error(message), { code });
const isInside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const notWritable = () => fail('denied', 'That path is not writable.');

function safeRel(rel) {
  if (typeof rel !== 'string' || rel.length > 4096 || path.isAbsolute(rel)) throw fail('invalid', 'The path is not valid.');
  const parts = rel.replaceAll('\\', '/').split('/');
  if (parts.some((p) => p === '..' || p === '')) throw fail('invalid', 'The path is not valid.');
  return parts.join(path.sep);
}

export function writeProjectFile({ root, path: rel, text, expectedHash, mustNotExist = false, create = false }) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TEXT || text.includes('\0')) throw fail('invalid', 'The text is too large or not text.');
  if (mustNotExist && expectedHash) throw fail('invalid', 'expectedHash and mustNotExist cannot be combined.');
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, safeRel(rel));
  const parentPath = path.dirname(target);
  // Deny the lexical path BEFORE mkdir: refusing `.git/…` must not leave a `.git` folder behind.
  if (isDeniedPath(target)) throw notWritable();
  if (!fs.existsSync(parentPath)) {
    if (!create) throw fail('not_found', 'That folder does not exist.');
    // Find the nearest existing ancestor before creating anything, so a symlinked parent cannot create folders outside.
    let ancestor = parentPath;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const realAncestor = fs.realpathSync(ancestor);
    if (!isInside(realAncestor, realRoot)) throw fail('denied', 'That path is outside the project.');
    // Project the not-yet-created suffix under the canonical ancestor: a symlinked
    // parent that resolves into `.git` must be refused before mkdir enters it.
    if (isDeniedPath(path.join(realAncestor, path.relative(ancestor, parentPath), path.basename(target)))) throw notWritable();
    fs.mkdirSync(parentPath, { recursive: true });
  }
  // Resolve the parent again and deny on the canonical path too, so an in-project
  // symlink (e.g. `alias -> .git`) cannot bypass the lexical denylist.
  const parent = fs.realpathSync(parentPath);
  if (!isInside(parent, realRoot)) throw fail('denied', 'That path is outside the project.');
  if (isDeniedPath(path.join(parent, path.basename(target)))) throw notWritable();
  let current = null;
  let mode = 0o600; // a new file; an overwrite keeps its own mode (an executable script must stay executable)
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) throw fail('denied', 'That path is a symbolic link.');
    if (!st.isFile()) throw fail('denied', 'That path is not a regular file.');
    mode = st.mode & 0o777;
    current = hashText(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') { /* missing */ } else if (e.code && /^E[A-Z]+$/.test(e.code)) {
      // A raw fs message carries the absolute host path; the client gets a code, not the path.
      throw fail('denied', 'That file could not be read.');
    } else throw e; // our own refusal
  }
  if (mustNotExist) {
    if (current !== null) throw fail('conflict', 'The file already exists.');
  } else if (expectedHash) {
    if (current === null) throw fail('not_found', 'The file does not exist.');
    if (current !== expectedHash) throw fail('conflict', 'The file changed since you opened it.');
  }
  const tmp = `${target}.llmide-${process.pid}-${Date.now()}.tmp`;
  let tempWritten = false;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode, flag: 'wx' });
    tempWritten = true;
    fs.renameSync(tmp, target);
  } finally {
    if (tempWritten) { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
  }
  return { hash: hashText(text), size: Buffer.byteLength(text, 'utf8') };
}
