// Doc Gen project-folder IO: scan, write, delete and seed `templates/<folder>/
// template.md` and `commands/<folder>/command.md` under a project root.
//
// Confinement follows the Mac System bridge (mac/.../Features/System/Services/
// SystemBridge.swift, `confinedFile` / `openRegularFile`):
//   - the root must be a real directory, not a symlink, not over-broad
//     (`isOverBroadRoot`), and carry the LLM-IDE project marker;
//   - every path is resolved and must stay inside the root;
//   - reads open with O_NOFOLLOW and check the descriptor is a regular file;
//   - dotfiles are never read, and a file over MAX_FILE_BYTES is skipped;
//   - writes go through a temp file and rename, and never follow a symlink in
//     the folder path.
// Pure text logic lives in kb/doc-templates.mjs; this module only moves bytes.

import {
  closeSync, constants as fsc, existsSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync,
  unlinkSync, writeFileSync, accessSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import {
  COMMAND_MARKER, FOLDER_NAME_RE, INGEST_TEMPLATE_FOLDERS, RESERVED_TEMPLATE_FOLDERS, TEMPLATE_MARKER,
  commandRecord, ensureSurfaceMarker, isIngestTemplate,
  renderCommandMarkdown, renderTemplateMarkdown,
  templateRecord, compareNames, normalizeSurface, rewriteTemplateMarkdown,
} from './doc-templates.mjs';
import { TEMPLATES_README, COMMANDS_README } from './doc-readmes.mjs';

/** Largest template or command file the scanner or a write will handle. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Largest existing file the ingest-layout check reads before a write or delete. */
const INGEST_CHECK_MAX_BYTES = 4 * 1024 * 1024;

/** Folder entries examined per family (templates/, commands/) by one scan. */
export const MAX_SCAN_FOLDERS = 2000;

/** Swift `SystemBridge.refusedRootPaths`: never a project root, whatever it resolves to. */
export const REFUSED_ROOT_PATHS = Object.freeze([
  '/', '/Users', '/Volumes', '/private', '/System', '/Library', '/Applications',
]);

/**
 * System folders refused as a root by exact path (the realpath or the path as
 * given). Not ancestors: a project may live under /Users, just not be /Users.
 */
export const REFUSED_SYSTEM_ROOTS = Object.freeze([
  '/etc', '/private/etc', '/var', '/private/var', '/usr', '/bin', '/sbin', '/opt',
  '/System', '/Library', '/Applications', '/Volumes', '/Users', '/private',
]);

/**
 * Folder names refused anywhere in a root's path: credential and tooling
 * stores. Same list as Swift `SystemBridge.sensitiveDirectoryNames`; matched
 * case-insensitively, component by component.
 */
export const SENSITIVE_DIRECTORY_NAMES = Object.freeze(['.git', '.ssh', '.gnupg', '.aws', '.kube', '.docker']);

const PROJECT_MARKER = join('system', 'project.json');
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const NO_FOLLOW = (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0);

/** An error the route maps to an HTTP status: `code` names it on the wire. */
export class DocFilesError extends Error {
  /**
   * @param {string} code  the wire code (docs.schema.json)
   * @param {string} message  safe to show the client
   * @param {number} [status]  HTTP status; the route's table applies when absent
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'DocFilesError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Swift `SystemBridge.isOverBroadRoot`: refused names, the home dir, or an ancestor of it. */
export function isOverBroadRoot(rootPath, homePath) {
  if (REFUSED_ROOT_PATHS.includes(rootPath)) return true;
  const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  return homePath === rootPath || homePath.startsWith(prefix);
}

/**
 * Validate a project root the Mac registers. Returns the realpath.
 * Refused: a relative path, a control character, a missing path, a symlink at
 * the root itself, a non-directory, an over-broad root, and a folder without
 * the LLM-IDE project marker (`system/project.json`).
 */
export function validateProjectRoot(raw, { home = homedir() } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DocFilesError('INVALID_ROOT', 'root is required');
  }
  if (raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new DocFilesError('INVALID_ROOT', 'root contains invalid characters');
  }
  if (!isAbsolute(raw)) {
    throw new DocFilesError('INVALID_ROOT', 'root must be an absolute path');
  }
  let st;
  try {
    st = lstatSync(raw);
  } catch {
    throw new DocFilesError('ROOT_NOT_FOUND', 'root does not exist');
  }
  if (st.isSymbolicLink()) {
    throw new DocFilesError('INVALID_ROOT', 'root must not be a symbolic link');
  }
  if (!st.isDirectory()) {
    throw new DocFilesError('INVALID_ROOT', 'root must be a directory');
  }
  const real = realpathSync(raw);
  // A home that does not resolve (never on a real Mac) is compared as given.
  let homeReal = home;
  try {
    homeReal = realpathSync(home);
  } catch {
    homeReal = home;
  }
  if (isOverBroadRoot(real, homeReal) || REFUSED_SYSTEM_ROOTS.includes(raw) || REFUSED_SYSTEM_ROOTS.includes(real)) {
    throw new DocFilesError('INVALID_ROOT', 'root is too broad (home, an ancestor of home, or a system folder)');
  }
  if (hasSensitiveComponent(real)) {
    throw new DocFilesError('INVALID_ROOT', 'root is inside a credential or tooling folder');
  }
  try {
    accessSync(real, fsc.R_OK);
  } catch {
    throw new DocFilesError('ROOT_NOT_FOUND', 'root is not readable by the server');
  }
  let marker;
  try {
    marker = lstatSync(join(real, PROJECT_MARKER));
  } catch {
    marker = null;
  }
  if (!marker || !marker.isFile()) {
    throw new DocFilesError('NOT_A_PROJECT', 'root is not an LLM-IDE project (missing system/project.json)');
  }
  return real;
}

/** True when any component of `path` is a sensitive directory name (case-insensitive). */
export function hasSensitiveComponent(path) {
  return path.split(sep).some((c) => SENSITIVE_DIRECTORY_NAMES.includes(c.toLowerCase()));
}

/** True when `candidate` (a realpath) is `root` or inside it. */
function insideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Read a regular file under `root` as UTF-8 text. Returns null for anything
 * else: a missing file, a symlink (at any depth, its realpath must stay in the
 * root and the final component is opened with O_NOFOLLOW), a non-regular file,
 * an oversize file, or bytes that are not valid UTF-8 (Swift's
 * `String(contentsOf:encoding: .utf8)` fails on those, so the file is skipped).
 */
export function readConfinedText(root, absPath, maxBytes = MAX_FILE_BYTES) {
  let real;
  try {
    real = realpathSync(absPath);
  } catch {
    return null;
  }
  if (!insideRoot(root, real)) return null;
  let fd;
  try {
    fd = openSync(absPath, fsc.O_RDONLY | NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, null);
      if (n === 0) break;
      off += n;
    }
    return TEXT_DECODER.decode(buf.subarray(0, off));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The directory `root/<segments…>` if every existing segment is a real
 * directory (not a symlink) inside the root; null otherwise.
 */
function confinedDir(root, segments) {
  let cur = root;
  for (let i = 0; i < segments.length; i += 1) {
    cur = join(cur, segments[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      // Does not exist yet: nothing below it can be a symlink, so the rest of
      // the path is joined as-is and the caller creates it.
      return join(cur, ...segments.slice(i + 1));
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
  }
  return cur;
}

/** Folder entries of `root/<family>`: non-dot real directories, sorted by name. */
function familyFolders(root, family) {
  const dir = confinedDir(root, [family]);
  if (!dir || !existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.') && e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * The file a folder's entry is read from: its preferred name (`template.md`
 * or `command.md`) when present, else the first non-dot `.md` file in name
 * order (the Swift stores take the first `.md` the directory lists).
 */
function entryFile(root, folderAbs, preferred) {
  if (existsSync(join(folderAbs, preferred))) return join(folderAbs, preferred);
  let names;
  try {
    names = readdirSync(folderAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  const md = names
    .filter((e) => !e.name.startsWith('.') && e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort();
  return md.length ? join(folderAbs, md[0]) : null;
}

/**
 * Scan one family. At most MAX_SCAN_FOLDERS folder entries (the first by name)
 * are examined; `truncated` says whether the family had more.
 */
function scanFamily(root, family, preferred, build) {
  const all = familyFolders(root, family);
  const folders = all.slice(0, MAX_SCAN_FOLDERS);
  const items = [];
  for (const folder of folders) {
    const folderAbs = join(root, family, folder);
    const file = entryFile(root, folderAbs, preferred);
    if (!file) continue;
    const content = readConfinedText(root, file);
    if (content === null) continue;
    const item = build(folder, content);
    if (item) items.push(item);
  }
  return {
    items: items.sort((a, b) => compareNames(a.name, b.name)),
    truncated: all.length > MAX_SCAN_FOLDERS,
    scannedFolders: folders.length,
  };
}

/**
 * Every Doc Gen template in `root/templates/` with the scan bounds. Skips the
 * `auto_task/` folder (Auto Task prompts) and ingest layouts
 * (`{{placeholder}}` templates). Sorted by name, as the Swift store publishes them.
 * @returns {{ templates: object[], truncated: boolean, scannedFolders: number }}
 */
export function scanTemplatesPage(root) {
  const page = scanFamily(root, 'templates', 'template.md', (folder, content) => {
    if (RESERVED_TEMPLATE_FOLDERS.includes(folder) || isIngestTemplate(content)) return null;
    return templateRecord({ folderName: folder, content });
  });
  return { templates: page.items, truncated: page.truncated, scannedFolders: page.scannedFolders };
}

/** `scanTemplatesPage(root).templates`. */
export function scanTemplates(root) {
  return scanTemplatesPage(root).templates;
}

/** Every Doc Gen command in `root/commands/` with the scan bounds, sorted by name. */
export function scanCommandsPage(root) {
  const page = scanFamily(root, 'commands', 'command.md', (folder, content) => commandRecord({ folderName: folder, content }));
  return { commands: page.items, truncated: page.truncated, scannedFolders: page.scannedFolders };
}

/** `scanCommandsPage(root).commands`. */
export function scanCommands(root) {
  return scanCommandsPage(root).commands;
}

/**
 * A folder name a route may write or delete. Refused: a name outside
 * FOLDER_NAME_RE, `auto_task` in any casing (a case-insensitive disk would
 * otherwise reach it), and under templates/ the ingest layout names.
 */
export function assertFolderName(folderName, family = 'templates') {
  if (typeof folderName !== 'string' || !FOLDER_NAME_RE.test(folderName)) {
    throw new DocFilesError('INVALID_FOLDER', 'folder name must start with a letter or digit and use letters, digits, _ or - (max 80)');
  }
  const lower = folderName.toLowerCase();
  const reserved = family === 'templates'
    ? [...RESERVED_TEMPLATE_FOLDERS, ...INGEST_TEMPLATE_FOLDERS]
    : RESERVED_TEMPLATE_FOLDERS;
  if (reserved.includes(lower)) {
    throw new DocFilesError('RESERVED_FOLDER', `folder name "${folderName}" is reserved`, 400);
  }
  return folderName;
}

/**
 * The name of the existing folder a request addresses. An exact match wins;
 * otherwise a folder that differs only by case is the one written into (on a
 * case-insensitive disk it is the same folder anyway), so the response names
 * the true directory entry.
 */
function canonicalFolder(root, family, folderName) {
  const dir = confinedDir(root, [family]);
  if (!dir || !existsSync(dir)) return folderName;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return folderName;
  }
  if (names.includes(folderName)) return folderName;
  const lower = folderName.toLowerCase();
  return names.filter((n) => n.toLowerCase() === lower).sort()[0] ?? folderName;
}

/** Create one path segment under `parent` (non-recursive), then check it is a plain directory. */
function ensureSegment(parent, name) {
  const p = join(parent, name);
  try {
    mkdirSync(p);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  let st;
  try {
    st = lstatSync(p);
  } catch {
    throw new DocFilesError('UNSAFE_PATH', `${name} vanished while it was being created`);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new DocFilesError('UNSAFE_PATH', `${name} is not a plain directory`);
  }
  return p;
}

/** True when `dir` is still a plain directory inside `root` (checked again right before a rename). */
function assertStillPlain(root, dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new DocFilesError('UNSAFE_PATH', 'folder changed while it was being written');
  }
  if (!st.isDirectory() || st.isSymbolicLink() || !insideRoot(root, realpathSync(dir))) {
    throw new DocFilesError('UNSAFE_PATH', 'folder changed while it was being written');
  }
}

/**
 * Create `root/<family>/<folder>` one segment at a time (`root/<family>` is
 * created, lstat-checked, then the folder), and check the final realpath is
 * inside the root before anything is written. A symlink that appears at either
 * step aborts with UNSAFE_PATH and nothing is written.
 */
function ensureFolder(root, family, folderName) {
  const famDir = ensureSegment(root, family);
  const folderDir = ensureSegment(famDir, folderName);
  if (!insideRoot(root, realpathSync(folderDir))) {
    throw new DocFilesError('UNSAFE_PATH', 'folder resolves outside the project');
  }
  return folderDir;
}

function tempName(dir, name) {
  return join(dir, `.${name}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`);
}

function unlinkQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never created.
  }
}

function assertWithinSize(content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new DocFilesError('TOO_LARGE', `file is larger than ${MAX_FILE_BYTES} bytes`);
  }
}

/**
 * Write `content` to `dir/name` through a temp file and a rename (overwrites).
 * The temp file is removed on every failure path.
 */
function atomicWrite(root, dir, name, content) {
  assertWithinSize(content);
  const tmp = tempName(dir, name);
  let moved = false;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    assertStillPlain(root, dir);
    try {
      renameSync(tmp, join(dir, name));
    } catch {
      // A directory (or other non-replaceable entry) sits at the name.
      throw new DocFilesError('UNSAFE_PATH', `${name} cannot be replaced`);
    }
    moved = true;
  } finally {
    if (!moved) unlinkQuietly(tmp);
  }
}

/**
 * Write `content` to `dir/name` only when no entry of that name exists. The
 * temp file is hard-linked into place: link() fails with EEXIST when the name
 * is taken, so a concurrent write is never replaced. On a filesystem without
 * hard links the check-then-rename fallback is used.
 * @returns {boolean} true when this call wrote the file
 */
function writeIfAbsent(root, dir, name, content) {
  assertWithinSize(content);
  const tmp = tempName(dir, name);
  const dest = join(dir, name);
  writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    assertStillPlain(root, dir);
    linkSync(tmp, dest);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    if (err?.code === 'EPERM' || err?.code === 'ENOTSUP' || err?.code === 'EOPNOTSUPP') {
      if (existsSync(dest)) return false;
      renameSync(tmp, dest);
      return true;
    }
    throw err;
  } finally {
    unlinkQuietly(tmp);
  }
}

/**
 * Refuse a write or delete over an ingest layout (`templates/<kind>/template.md`
 * carrying `llmide:ingest-template`): the Mac's ingest renderer owns it, and
 * scanning hides it, so a Doc Gen write would destroy a file the user cannot see.
 */
function assertNotIngestLayout(root, file) {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return;
  }
  // A directory at the name is not a layout; the rename refuses it (atomicWrite).
  if (st.isDirectory()) return;
  const content = readConfinedText(root, file, INGEST_CHECK_MAX_BYTES);
  if (content === null) {
    // Not a plain UTF-8 file under the cap: refuse rather than overwrite what cannot be inspected.
    throw new DocFilesError('UNSAFE_PATH', 'existing file is not a plain text file under 4 MB');
  }
  if (isIngestTemplate(content)) {
    throw new DocFilesError('RESERVED_FOLDER', 'this folder holds an ingest layout, not a Doc Gen template', 409);
  }
}

/**
 * Write a template. With `rawContent` the file is that text (the Swift
 * `renderedMarkdown()` rule). Without it, the body is rendered from name,
 * sections and surface. `rewrite: true` applies the title and section list to
 * the existing file, keeping its body text (`rewriteTemplateMarkdown`).
 * Precedence: `rawContent` wins over `rewrite`. Returns the saved record, whose
 * folderName is the true directory entry (case may differ from the request).
 */
export function writeTemplate(root, folderName, input) {
  const requested = assertFolderName(folderName, 'templates');
  const actual = canonicalFolder(root, 'templates', requested);
  const dir = ensureFolder(root, 'templates', actual);
  const file = join(dir, 'template.md');
  assertNotIngestLayout(root, file);
  const surface = normalizeSurface(input.surface);
  const name = String(input.name ?? actual);
  const sections = Array.isArray(input.sections) ? input.sections.map(String) : [];
  let content;
  if (input.rewrite === true && input.rawContent === undefined && existsSync(file)) {
    const raw = readConfinedText(root, file) ?? '';
    content = rewriteTemplateMarkdown(raw, name, sections);
  } else {
    content = renderTemplateMarkdown({
      rawContent: input.rawContent, name, sections, surface,
    });
  }
  atomicWrite(root, dir, 'template.md', content);
  return templateRecord({ folderName: actual, content });
}

/** Write a command. Same rules as `writeTemplate`; `instruction` is the body. */
export function writeCommand(root, folderName, input) {
  const requested = assertFolderName(folderName, 'commands');
  const actual = canonicalFolder(root, 'commands', requested);
  const dir = ensureFolder(root, 'commands', actual);
  const surface = normalizeSurface(input.surface);
  const content = renderCommandMarkdown({
    rawContent: input.rawContent,
    name: String(input.name ?? actual),
    instruction: String(input.instruction ?? ''),
    surface,
  });
  atomicWrite(root, dir, 'command.md', content);
  return commandRecord({ folderName: actual, content });
}

/**
 * Delete a template or command: removes ONLY its `template.md` / `command.md`,
 * then removes the folder when that left it empty. A folder that still holds
 * user files is kept (`folderRemoved: false`); nothing is ever removed
 * recursively. Returns null when the folder or its entry file is absent, and
 * refuses a symlink, a non-regular entry and an ingest layout.
 * @returns {{ folderName: string, folderRemoved: boolean } | null}
 */
export function deleteFolder(root, family, folderName) {
  const requested = assertFolderName(folderName, family);
  const actual = canonicalFolder(root, family, requested);
  const dir = confinedDir(root, [family, actual]);
  if (!dir) throw new DocFilesError('UNSAFE_PATH', 'folder is not a plain directory');
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new DocFilesError('UNSAFE_PATH', 'folder is not a plain directory');
  }
  const real = realpathSync(dir);
  if (!insideRoot(root, real)) throw new DocFilesError('UNSAFE_PATH', 'folder resolves outside the project');
  const preferred = family === 'templates' ? 'template.md' : 'command.md';
  // The entry the scan lists: the preferred file, else the first `.md` (the
  // same rule `scanFamily` uses), so a folder the list shows can always be deleted.
  const file = entryFile(root, dir, preferred);
  if (!file) return null;
  let fst;
  try {
    fst = lstatSync(file);
  } catch {
    return null;
  }
  if (!fst.isFile() || fst.isSymbolicLink()) {
    throw new DocFilesError('UNSAFE_PATH', 'entry file is not a plain file');
  }
  if (family === 'templates') assertNotIngestLayout(root, file);
  unlinkSync(file);
  let folderRemoved = true;
  try {
    rmdirSync(dir);
  } catch (err) {
    // ENOTEMPTY / EEXIST: the folder holds user files. Keep them.
    if (err?.code !== 'ENOTEMPTY' && err?.code !== 'EEXIST') throw err;
    folderRemoved = false;
  }
  return { folderName: actual, folderRemoved };
}

/**
 * Seed a project with the kit's defaults (`ProjectDocTemplatesSeeder` and
 * `ProjectDocCommandsSeeder`). `kit` is `{ templates, commands }` as
 * `listGenerationLibrary` returns it: entries with `id` (`<family>/<folder>`),
 * `body` and `surface`. Idempotent: an existing file is never overwritten, so
 * a user's edit survives every reopen. Returns the relative paths written.
 */
export function seedProjectFiles(root, kit = {}) {
  const written = [];
  const templatesDir = ensureSegment(root, 'templates');
  if (writeIfAbsent(root, templatesDir, 'README.md', TEMPLATES_README)) written.push('templates/README.md');
  for (const entry of kit.templates ?? []) {
    const folder = folderOf(entry);
    if (!folder) continue;
    const dir = ensureFolder(root, 'templates', canonicalFolder(root, 'templates', folder));
    const body = ensureSurfaceMarker(entry.body ?? '', TEMPLATE_MARKER, entry.surface);
    if (writeIfAbsent(root, dir, 'template.md', body)) written.push(`templates/${folder}/template.md`);
  }
  const commandsDir = ensureSegment(root, 'commands');
  if (writeIfAbsent(root, commandsDir, 'README.md', COMMANDS_README)) written.push('commands/README.md');
  for (const entry of kit.commands ?? []) {
    const folder = folderOf(entry);
    if (!folder) continue;
    const dir = ensureFolder(root, 'commands', canonicalFolder(root, 'commands', folder));
    const body = ensureSurfaceMarker(entry.body ?? '', COMMAND_MARKER, entry.surface);
    if (writeIfAbsent(root, dir, 'command.md', body)) written.push(`commands/${folder}/command.md`);
  }
  return written;
}

/** The folder a kit entry seeds into: the last segment of its id, when a valid name. */
function folderOf(entry) {
  const stem = String(entry?.id ?? '').split('/').pop() ?? '';
  if (!FOLDER_NAME_RE.test(stem)) return null;
  const lower = stem.toLowerCase();
  if ([...RESERVED_TEMPLATE_FOLDERS, ...INGEST_TEMPLATE_FOLDERS].includes(lower)) return null;
  return stem;
}

/**
 * Where a Doc Gen save goes (`DocGenOutputConfig.resolvedDirectory`): the
 * explicit folder when set, else `<project>/data`, else null (the caller falls
 * back to Downloads). The output config is still owned by Swift until K3
 * (docs-kit §5a); this is its server twin, pinned by the same tests.
 */
export function resolveOutputDirectory({ localFolderPath, projectRoot } = {}) {
  if (typeof localFolderPath === 'string' && localFolderPath !== '') return localFolderPath;
  if (typeof projectRoot === 'string' && projectRoot !== '') return join(projectRoot, 'data');
  return null;
}
