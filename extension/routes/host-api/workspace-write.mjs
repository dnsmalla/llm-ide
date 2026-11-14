// Confined writer for Host API `files.write`: the remote client names a path
// relative to the project root, and this module refuses everything outside it.
//
// SECURITY MODEL:
//   - `..`, absolute paths and empty segments are rejected before touching disk.
//   - The nearest existing ancestor is realpath'd BEFORE any folder is created,
//     so a symlinked parent cannot make us create folders outside the project.
//   - A final symlink is refused (a write must never follow a link out).
//   - The same denylist as the read side (`isDeniedPath`) refuses `.git`,
//     `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker` and secret files.
//   - Writes are atomic: sibling temp file + rename.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeniedPath } from '../../llm_agent/tools/handlers/repo-files.mjs';

export const MAX_TEXT = 262_144;
export const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function safeRel(rel) {
  if (typeof rel !== 'string' || rel.length > 4096 || path.isAbsolute(rel)) throw Object.assign(new Error('The path is not valid.'), { code: 'invalid' });
  const parts = rel.replaceAll('\\', '/').split('/');
  if (parts.some((p) => p === '..' || p === '')) throw Object.assign(new Error('The path is not valid.'), { code: 'invalid' });
  return parts.join(path.sep);
}

export function writeProjectFile({ root, path: rel, text, expectedHash, mustNotExist = false, create = false }) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TEXT || text.includes('\0')) throw Object.assign(new Error('The text is too large or not text.'), { code: 'invalid' });
  if (mustNotExist && expectedHash) throw Object.assign(new Error('expectedHash and mustNotExist cannot be combined.'), { code: 'invalid' });
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, safeRel(rel));
  // Deny BEFORE mkdir: refusing `.git/…` must not leave a `.git` folder behind.
  if (isDeniedPath(target)) throw Object.assign(new Error('That path is not writable.'), { code: 'denied' });
  // Find the nearest existing ancestor before creating anything, so a symlinked parent cannot create folders outside.
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) throw Object.assign(new Error('That path is outside the project.'), { code: 'denied' });
  if (!fs.existsSync(path.dirname(target))) {
    if (!create) throw Object.assign(new Error('That folder does not exist.'), { code: 'not_found' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) throw Object.assign(new Error('That path is outside the project.'), { code: 'denied' });
  let current = null;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw Object.assign(new Error('That path is a symbolic link.'), { code: 'denied' });
    current = hashText(fs.readFileSync(target, 'utf8'));
  } catch (e) { if (e.code === 'denied') throw e; /* missing */ }
  if (mustNotExist) {
    if (current !== null) throw Object.assign(new Error('The file already exists.'), { code: 'conflict' });
  } else if (expectedHash && current !== expectedHash) {
    throw Object.assign(new Error('The file changed since you opened it.'), { code: 'conflict' });
  }
  const tmp = `${target}.llmide-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  return { hash: hashText(text), size: Buffer.byteLength(text, 'utf8') };
}
