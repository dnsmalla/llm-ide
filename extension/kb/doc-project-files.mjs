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
  closeSync, constants as fsc, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readdirSync, readSync, realpathSync, renameSync, rmSync,
  writeFileSync, accessSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import {
  COMMAND_MARKER, FOLDER_NAME_RE, RESERVED_TEMPLATE_FOLDERS, TEMPLATE_MARKER,
  commandRecord, ensureSurfaceMarker, isIngestTemplate,
  renderCommandMarkdown, renderTemplateMarkdown,
  templateRecord, compareNames, normalizeSurface, rewriteTemplateMarkdown,
} from './doc-templates.mjs';
import { TEMPLATES_README, COMMANDS_README } from './doc-readmes.mjs';

/** Largest template or command file the scanner or a write will handle. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Swift `SystemBridge.refusedRootPaths`: never a project root, whatever it resolves to. */
export const REFUSED_ROOT_PATHS = Object.freeze([
  '/', '/Users', '/Volumes', '/private', '/System', '/Library', '/Applications',
]);

const PROJECT_MARKER = join('system', 'project.json');
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const NO_FOLLOW = (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0);

/** An error the route maps to an HTTP status: `code` names it on the wire. */
export class DocFilesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocFilesError';
    this.code = code;
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
  if (isOverBroadRoot(real, homeReal)) {
    throw new DocFilesError('INVALID_ROOT', 'root is too broad (home, an ancestor of home, or a system folder)');
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
 * Every Doc Gen template in `root/templates/`. Skips the `auto_task/` folder
 * (Auto Task prompts) and ingest layouts (`{{placeholder}}` templates).
 * Sorted by name, as the Swift store publishes them.
 */
export function scanTemplates(root) {
  const out = [];
  for (const folder of familyFolders(root, 'templates')) {
    if (RESERVED_TEMPLATE_FOLDERS.includes(folder)) continue;
    const folderAbs = join(root, 'templates', folder);
    const file = entryFile(root, folderAbs, 'template.md');
    if (!file) continue;
    const content = readConfinedText(root, file);
    if (content === null || isIngestTemplate(content)) continue;
    out.push(templateRecord({ folderName: folder, content }));
  }
  return out.sort((a, b) => compareNames(a.name, b.name));
}

/** Every Doc Gen command in `root/commands/`, sorted by name. */
export function scanCommands(root) {
  const out = [];
  for (const folder of familyFolders(root, 'commands')) {
    const folderAbs = join(root, 'commands', folder);
    const file = entryFile(root, folderAbs, 'command.md');
    if (!file) continue;
    const content = readConfinedText(root, file);
    if (content === null) continue;
    out.push(commandRecord({ folderName: folder, content }));
  }
  return out.sort((a, b) => compareNames(a.name, b.name));
}

/** A folder name a route may write (`FOLDER_NAME_RE`, never `auto_task`). */
export function assertFolderName(folderName) {
  if (typeof folderName !== 'string' || !FOLDER_NAME_RE.test(folderName)) {
    throw new DocFilesError('INVALID_FOLDER', 'folder name must start with a letter or digit and use letters, digits, _ or - (max 80)');
  }
  if (RESERVED_TEMPLATE_FOLDERS.includes(folderName)) {
    throw new DocFilesError('RESERVED_FOLDER', `folder name "${folderName}" is reserved`);
  }
  return folderName;
}

/** Create `root/<family>/<folder>` (confined) and return its absolute path. */
function ensureFolder(root, family, folderName) {
  const famDir = confinedDir(root, [family]);
  if (!famDir) throw new DocFilesError('UNSAFE_PATH', `${family}/ is not a plain directory`);
  const folderDir = confinedDir(root, [family, folderName]);
  if (!folderDir) throw new DocFilesError('UNSAFE_PATH', `${family}/${folderName} is not a plain directory`);
  mkdirSync(folderDir, { recursive: true });
  const real = realpathSync(folderDir);
  if (!insideRoot(root, real)) throw new DocFilesError('UNSAFE_PATH', 'folder resolves outside the project');
  return folderDir;
}

/** Write `content` to `dir/name` through a temp file and a rename. */
function atomicWrite(dir, name, content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new DocFilesError('TOO_LARGE', `file is larger than ${MAX_FILE_BYTES} bytes`);
  }
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, join(dir, name));
}

/**
 * Write a template. With `rawContent` the file is that text (the Swift
 * `renderedMarkdown()` rule). Without it, the body is rendered from name,
 * sections and surface. `rewrite: true` applies the title and section list to
 * the existing file, keeping its body text (`rewriteTemplateMarkdown`).
 * Returns the saved template record.
 */
export function writeTemplate(root, folderName, input) {
  assertFolderName(folderName);
  const dir = ensureFolder(root, 'templates', folderName);
  const file = join(dir, 'template.md');
  const surface = normalizeSurface(input.surface);
  const name = String(input.name ?? folderName);
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
  atomicWrite(dir, 'template.md', content);
  return templateRecord({ folderName, content });
}

/** Write a command. Same rules as `writeTemplate`; `instruction` is the body. */
export function writeCommand(root, folderName, input) {
  assertFolderName(folderName);
  const dir = ensureFolder(root, 'commands', folderName);
  const surface = normalizeSurface(input.surface);
  const content = renderCommandMarkdown({
    rawContent: input.rawContent,
    name: String(input.name ?? folderName),
    instruction: String(input.instruction ?? ''),
    surface,
  });
  atomicWrite(dir, 'command.md', content);
  return commandRecord({ folderName, content });
}

/**
 * Remove `root/<family>/<folder>` entirely. Returns false when it is absent.
 * A folder that is a symlink is refused, never followed.
 */
export function deleteFolder(root, family, folderName) {
  assertFolderName(folderName);
  const dir = confinedDir(root, [family, folderName]);
  if (!dir) throw new DocFilesError('UNSAFE_PATH', 'folder is not a plain directory');
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new DocFilesError('UNSAFE_PATH', 'folder is not a plain directory');
  }
  const real = realpathSync(dir);
  if (!insideRoot(root, real)) throw new DocFilesError('UNSAFE_PATH', 'folder resolves outside the project');
  rmSync(dir, { recursive: true, force: false });
  return true;
}

/** Write `content` to `dir/name` only when it is absent (`writeIfAbsent`). */
function writeIfAbsent(dir, name, content) {
  if (existsSync(join(dir, name))) return false;
  atomicWrite(dir, name, content);
  return true;
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
  const templatesDir = ensureFamilyDir(root, 'templates');
  if (writeIfAbsent(templatesDir, 'README.md', TEMPLATES_README)) written.push('templates/README.md');
  for (const entry of kit.templates ?? []) {
    const folder = folderOf(entry);
    if (!folder) continue;
    const dir = ensureFolder(root, 'templates', folder);
    const body = ensureSurfaceMarker(entry.body ?? '', TEMPLATE_MARKER, entry.surface);
    if (writeIfAbsent(dir, 'template.md', body)) written.push(`templates/${folder}/template.md`);
  }
  const commandsDir = ensureFamilyDir(root, 'commands');
  if (writeIfAbsent(commandsDir, 'README.md', COMMANDS_README)) written.push('commands/README.md');
  for (const entry of kit.commands ?? []) {
    const folder = folderOf(entry);
    if (!folder) continue;
    const dir = ensureFolder(root, 'commands', folder);
    const body = ensureSurfaceMarker(entry.body ?? '', COMMAND_MARKER, entry.surface);
    if (writeIfAbsent(dir, 'command.md', body)) written.push(`commands/${folder}/command.md`);
  }
  return written;
}

function ensureFamilyDir(root, family) {
  const dir = confinedDir(root, [family]);
  if (!dir) throw new DocFilesError('UNSAFE_PATH', `${family}/ is not a plain directory`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The folder a kit entry seeds into: the last segment of its id, when a valid name. */
function folderOf(entry) {
  const stem = String(entry?.id ?? '').split('/').pop() ?? '';
  return FOLDER_NAME_RE.test(stem) && !RESERVED_TEMPLATE_FOLDERS.includes(stem) ? stem : null;
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
